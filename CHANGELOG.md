# Changelog

All notable changes to the anima monorepo are tracked per-package via [changesets](./.changeset/). Root-level entries live here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.24.13] - 2026-05-16

### Fixed

- **v0.24.12 clarify-on-market-wake directive was overridden by `MARKETPLACE_GUIDANCE` and never fired in practice.** The plugin-comms guidance shipped with the older line "Never ask the operator for permission" which the brain treated as more specific and authoritative than the new global directive in `frozen-prefix.ts`. Observed live May 16 2026 ~14:30 WIB: enigma daemon on v0.24.12 received two autonomous `JobCreated` wakes (jobs #6 + #7), listener fired correctly, brain ran inference, but emitted zero tool calls — silent drop. Fix: rewrite the provider-side rules in `packages/plugin-comms/src/market-guidance.ts` so it expresses the same hesitate-and-ask behavior. New rule: on `job-offered` event with NO prior negotiation in `agent.history` with the buyer, call `clarify`; with prior negotiation, act autonomously. Buyer side stays autonomous on `markedDone` (settles the trade they already agreed to). Removed the over-eager global directive from frozen-prefix; the marketplace guidance is the single source of truth now (when comms plugin is loaded). TG broadcast wiring from v0.24.12 (`OperatorNotifierSlot` + `extractClarifyQuestion` in `build-runtime.onToolCall`) carries over unchanged.

### Tests

- Full repo: 1274/1274 unit tests pass, typecheck clean, biome clean.

[0.24.13]: https://github.com/s0nderlabs/anima/releases/tag/v0.24.13

## [0.24.12] - 2026-05-16

### Added

- **Autonomous market wakes now route clarify questions to the operator instead of silently dropping the wake.** v0.24.11 wired listener wakes for `JobCreated` / `JobAccepted` / `JobSettled` events so the brain *sees* the hire, but absent a system-prompt directive the brain stayed quiet (no auto-commit to paid work). System prompt updated: on `<channel source="market" kind="created" jobId="...">` blocks the brain now calls `clarify` to ask the operator whether to accept and deliver. The TUI surfaces the clarify question inline via existing SSE wiring. Sandbox-mode daemons additionally forward the question to every allowed Telegram chat when `events.size() === 0` (no live SSE subscribers), so TG-only operators see the prompt on their phone. Build-runtime `onToolCall` taps clarify calls, extracts the `question` (and any options) via `extractClarifyQuestion`, and broadcasts through a new `OperatorNotifierSlot` that the TG listener fills on start. Slot is cleared on `stop()` so duplicate broadcasts can't fire from a dead listener. Best-effort delivery: per-chat send failures log a warning but don't block the broadcast.

### Tests

- Full repo: 1274/1274 unit tests pass, typecheck clean, biome clean.

[0.24.12]: https://github.com/s0nderlabs/anima/releases/tag/v0.24.12

## [0.24.11] - 2026-05-16

### Fixed

- **A2A inbox listener silently dropped events after ~20h of uptime.** `watchContractEvent`'s HTTP polling subscription on long-running daemons would advance its cursor past blocks containing relevant `Message` events but never insert them into `history.db` — the brain saw no inbound, even though the messages were confirmed on chain (confirmed live May 16 2026: specter daemon at 20h57m uptime, fresh tx `0x4611f9de…` at block 33391419, cursor advanced to that block, zero new rows). Diagnosis: `getMessagesFor` on a stale viem filter returned empty despite the RPC having the logs. Restarting the daemon recovered immediately. Fix: `A2AListener` now runs a periodic safety-net `catchUp({ safety: true })` every `catchUpIntervalMs` (default 60s) that re-scans the last `catchUpSafetyBlocks` (default 240, ~12 min on 0G's 3s blocks). Idempotency via `HistoryStore.insert` returning a boolean (true on new row, false on PK conflict) + a cheap `HistoryStore.has(txHash, logIndex)` short-circuit BEFORE the expensive `resolveInbound` + ECIES decrypt steps in `handleEvent`. No double-brain-wake possible. `setInterval` is `.unref?.()`'d so the timer doesn't keep bun's event loop alive past daemon shutdown.

- **A2A inbound never woke the brain autonomously — only on the next operator chat turn.** `drainInbound` was only invoked at the end of `runChatTurn`, so an inbound from an approved contact would sit in `inboundQueue` indefinitely waiting for the operator to type something. Telegram already triggered `brain.infer` directly inside its plugin dispatcher; A2A mirrored that pattern only implicitly via the chat-turn-drain. Fix: `BuildRuntimeOpts` gained `onAutoTriggerInbox` / `onAutoTriggerMarket` callbacks; `RealRuntime.start` wires them to `void this.#drainInbound?.()` / `void this.#drainMarket?.()`. The boot-replay queue is also drained explicitly after `#wireDrains` to catch arrivals between `buildAnimaRuntime` returning and the drains being assigned. Verified live May 16: enigma → specter A2A round-trip with operator's TUI killed; specter daemon autonomously called `shell.run date`, replied via `agent.message` with `in_reply_to` threading, all without operator interaction.

- **`CursorStore`'s module-level `DEFAULT` object was returned by reference from `loadJson`, allowing mutation aliasing across parallel listener instances.** Replaced with a `defaultCursor()` factory that returns a fresh literal per call. The same latent pattern exists in `presence.ts` / `mutes.ts` / `contacts.ts` but is out of scope for this patch (single-daemon-per-agent in production prevents the cross-instance leak from biting).

### Added

- **`/healthz.listeners` now reports `a2a-inbox` and `a2a-market` state** alongside the existing `telegram` entry (`'active' | 'disabled' | 'failed'`). Operators can now spot a daemon whose comms listener registration failed without grepping the gateway log.

### Tests

- 3 new integration tests in `packages/plugin-comms/src/listener.test.ts` cover handleEvent idempotency on duplicate live delivery, safety-net catch-up recovering events the live subscribe missed, and safety-net replay through already-stored events staying a no-op.
- 1 new `state-stores.test.ts` test verifies `HistoryStore.insert` returns `true` on first insert, `false` on duplicate `(txHash, logIndex)`.
- Full repo: 2548/2548 unit tests pass, typecheck clean, biome clean.

[0.24.11]: https://github.com/s0nderlabs/anima/releases/tag/v0.24.11

## [0.24.10] - 2026-05-15

### Fixed

- **`anima gateway start` verifies each derived scope key against the on-disk encrypted artifact before caching it in `.operator-session`, and falls back to the legacy `signTypedDataLegacyEmptyDomain` variant when the canonical key fails AES-GCM auth.** v0.24.9 shipped a dual-path decrypt in `decryptAgentKey` + `decryptOperatorBlob`, but the daemon-boot path always loads via the cached `precomputedKey` (which intentionally skips the fallback). For pre-v0.24.9 WC-init'd agents (only known instance: fox tokenId #5), gateway-start would derive the canonical key, cache the wrong key, and the daemon would panic on first AES-GCM decrypt because the keystore-on-disk was encrypted under the legacy empty-EIP712Domain hash. `precomputeAllScopes` now accepts an optional `verifyKey` callback; gateway-start passes one that trial-decrypts `keystore.json` + `telegram-secrets.encrypted` with the candidate key. On verify failure, `precomputeAllScopes` calls the signer's legacy escape hatch, verifies the legacy key works, caches it, and propagates the legacy variant to remaining scopes (the EIP712Domain trap is a signer-wide property). LocalAccount signers (raw-privkey / keystore-file / keychain) skip the fallback path entirely since they don't expose the legacy method. Single MM popup per scope on a legacy-WC agent's first v0.24.10+ launch; zero behavior change for everyone else. Verified via 11 new unit tests (5 helpers + 6 verify-and-swap scenarios), 1270 unit tests pass total.

[0.24.10]: https://github.com/s0nderlabs/anima/releases/tag/v0.24.10

## [0.24.9] - 2026-05-15

### Fixed

- **WalletConnect operator signer now injects the canonical `EIP712Domain` field set into `eth_signTypedData_v4` payloads.** Pre-v0.24.9 the WC signer shipped typed-data verbatim, so MetaMask Mobile's `sanitizeData` inserted `EIP712Domain: []` (empty) and hashed the domain separator over `keccak256("EIP712Domain()")`. That diverged from viem's `hashTypedData` canonical hash (over the populated field list), so WC-init'd keystores produced a different AES key from LocalAccount-init'd keystores for the same operator + agent. New WC keystores now match LocalAccount + the apps/web `/console` canonical-decrypt path. Existing pre-v0.24.9 WC-init'd keystores remain decryptable via the new dual-path fallback: `decryptAgentKey` and `decryptOperatorBlob` try the canonical key first, and on AES-GCM auth failure call the legacy `signTypedDataLegacyEmptyDomain` escape hatch attached to the WC Account (raw-privkey / keystore-file / keychain signers never expose this method, so they keep canonical-only behavior). Verified via unit tests (3 new WC payload-shape tests + 5 new keystore-crypto dual-path tests). No live WC drive needed; the crypto path is fully self-contained.

[0.24.9]: https://github.com/s0nderlabs/anima/releases/tag/v0.24.9

## [0.24.8] - 2026-05-15

### Fixed

- **Glyph touched the label when a stage label hit exactly 32 chars (`LABEL_WIDTH`).** Visible only on the launchScript row (`launchScript uploaded to Daytona` is 32 chars exact); rendered as `Daytona✓` instead of `Daytona  ✓`. Shifted one trailing pad space to between label and glyph so every row has a 1-space gap regardless of label length. Caught live during the v0.24.7 enigma reprovision demo. No behavior change.

[0.24.8]: https://github.com/s0nderlabs/anima/releases/tag/v0.24.8

## [0.24.7] - 2026-05-15

### Changed

- **`anima init` and `anima upgrade --reprovision` now render a multi-line boxed progress UI during the bootstrap phase** instead of pinning a single-line clack spinner that scrolls past 1400+ identical frames on iPad SSH terminals. Stages render in a fixed-width box with elapsed-time stamps, a live spinner glyph on the current stage, and ✓ checkmarks as each stage completes. Box covers 8 stages: launchScript upload, apt update, system deps, bun runtime, anima install, browser deps, harness daemon spawn, /healthz Ready. Non-TTY callers (CI, piped stdout) fall back to per-transition log lines. Closes the v0.24.6 "(live progress below)" promise that the single-line clack spinner couldn't deliver. New `BootstrapProgressBox` helper (`packages/cli/src/util/bootstrap-progress-box.ts`) + new `onStageEvent` / `onTick` callbacks on `SandboxProvisionOpts` so structured stage transitions stream from the poll loop to the renderer instead of being formatted as free text.

[0.24.7]: https://github.com/s0nderlabs/anima/releases/tag/v0.24.7

## [0.24.6] - 2026-05-15

### Fixed

- **Bootstrap spinner pinned on `launching bootstrap (...)` for the first 30-180s of `anima init` sandbox provisioning.** v0.24.5 added a 5s heartbeat inside the post-launch poll loop, but the wait that hurts most was the launch call itself: `provider.execInToolbox(sandboxId, launchScript)` blocks on Daytona's HTTP API for 30-180s including retries, and no `progress(...)` fires during that window. Operators on screen-render-eager terminals (iPad SSH clients, certain tmux setups) saw 1400+ identical spinner frames accumulate in scrollback with no movement. Fix wraps `execInToolbox` with a background ticker that fires `progress("launching bootstrap (...) — Ns elapsed (uploading script, beat N)")` every 5s during the call, then cancels via `finally`. Operator now sees the elapsed-seconds counter advance even while the HTTP call is wedged in retries.

[0.24.6]: https://github.com/s0nderlabs/anima/releases/tag/v0.24.6

## [0.24.5] - 2026-05-15

### Fixed

- **Sandbox TG listener stays disabled after `anima init` despite Phase E configuring a bot.** Root cause: `handoffAgentToGateway` defaulted `runtimeConfig.plugins` to `['system','comms','onchain']` and callers never wired `plugins` through, so the runtime config sent to the sandbox omitted `'telegram'`. `build-runtime.ts` gates the listener on `pluginNames.includes('telegram')` and skipped registration. Telegram secrets reached the harness via the secondary ECIES envelope but the listener never started. New `resolveHandoffPlugins(caller, shipsTelegramSecrets)` helper auto-includes `'telegram'` in the plugin list whenever secrets are shipped, so all three handoff paths (init, in-place upgrade, reprovision-upgrade) activate the listener first try. Surfaced live during the v0.24.4 final init drive on nova.anima.0g — `/healthz` reported `listeners.telegram: "disabled"` even though `telegram-secrets.encrypted` was on disk and the config plugin list was correct. Same helper also dedupes the in-config-write path in `telegram-step.ts`.
- **Bootstrap progress spinner never updated during `anima init` sandbox provisioning.** Pre-fix, the poll loop only called `progress(...)` when a new `STAGE:` marker arrived from the bootstrap log. For the first ~30s of warmup the log is empty, and clack's spinner doesn't auto-refresh, so the operator saw `launching bootstrap...` pinned for the entire ~3 min run, then it jumped straight to `sandbox ... ready`. v0.24.5 unconditionally fires `progress(\`bootstrap waiting (Ns elapsed, tick N)\`)` every 5s tick when no new STAGE marker is available — guarantees the spinner reflects movement throughout the wait. STAGE markers from `bootstrap.ts` still take priority when present.

[0.24.5]: https://github.com/s0nderlabs/anima/releases/tag/v0.24.5

## [0.24.4] - 2026-05-15

### Fixed

- **`anima init` Phase E (Telegram setup) now runs BEFORE Phase 11 (sandbox provision)** so the sandbox-handoff envelope picks up `telegram-secrets.encrypted` from disk and ships it via the secondary ECIES envelope. Pre-fix, sandbox-deployed agents booted with `listeners.telegram: "disabled"` after a fresh init, forcing operators to run `anima upgrade --in-place` to re-ship secrets. `init.ts` reordered + new `skipConfigWrite` flag on `runTelegramStep` so the caller owns a single final config write (no partial-write hazard).
- **`anima init` subname survives the Telegram step.** Pre-fix, the `cfg` object passed to `runTelegramStep` had `subname: null` from `DEFAULT_CONFIG`, and `telegram-step.ts:203` re-wrote the config with that null, wiping the just-registered subname. Statusbar then couldn't render the `.0g` name. Fix at `init.ts:674` passes `{ ...cfg, subname: registeredSubname }`.

### Added

- **`POST /admin/pairing/approve`** signed admin endpoint on the gateway so sandbox-deployed agents can have Telegram pair-mode approvals routed from the operator's host CLI to the container's pairing dir. Pre-add, `anima pairing approve telegram <code>` wrote to the host's local `~/.anima/agents/<id>/pairing/` but the sandbox listener's pending list lived inside the container — host approvals silently never propagated. Auth: EIP-191 signed `adminTickHash({ action: 'pairing-approve', ts, sandboxId })`, same shape as `/admin/autotopup/tick`. `SandboxClient.approvePairing()` + `runPairingApprove` now detects `config.deployTarget === 'sandbox'` and routes through the remote endpoint.
- **TUI statusbar correctly distinguishes local-gateway vs sandbox connections.** Pre-fix, `chat-sandbox.tsx:178` hardcoded `connected to sandbox <id>` even when routed via unix socket to a local gateway daemon, and `ui/app.tsx:637` showed the `sandbox X.XX 0G` balance row unconditionally even on local deploys (where it's nonsensical). Now `isLocalGateway` is threaded through `createChatState`, the `initialSystem` text says `connected to local gateway` vs `connected to sandbox X @ Y` based on deploy target, and the sandbox-balance row is hidden on local. Also saves 2 RPC calls/min on local deploys (no more pointless `getSandboxBillingReserve` polling).
- **Bootstrap progress surfaces every 5s with STAGE markers** instead of a static label for 30+ seconds. `sandbox-provision.ts` poll modulo reduced from 6 (every 30s) to 1 (every 5s). `bootstrap.ts` now emits `STAGE:` lines at each named phase (`updating package index`, `installing system deps`, `installing bun runtime`, `installing anima (<ver>)`, `installing chrome for browser tools`, `starting harness daemon`, `harness ready`). New `extractBootstrapProgressLine` poller helper prefers STAGE lines over raw tail. Static label updated from "runs ~30-60s" (which omitted browser deps) to honest "~90-150s (live progress below)".

### Changed

- **`anima upgrade` post-flight version verifier accepts newer-than-requested as a soft pass.** Pre-fix, when npm registry `latest` was newer than the github release `latest` tag (common in the ship-window seconds after a tag push), the in-container `npm install @s0nderlabs/anima-cli@latest` pulled a newer version than the local CLI requested, and the verifier flagged "silent-success regression: expected X, got Y" + bailed out of handoff. Now `isSemverNewer(actual, expected)` treats this as expected behavior, surfaces a one-line note "harness landed Y (newer than requested X); continuing", and proceeds to handoff.

[0.24.4]: https://github.com/s0nderlabs/anima/releases/tag/v0.24.4

## [0.24.3] - 2026-05-14

### Fixed

- **`anima init` Telegram step now caches the `anima-telegram-v1` scope key in `.operator-session`.** Pre-fix, when an operator pasted a bot token in init's Phase E, the wizard called `saveTelegramSecrets()` which derived the TELEGRAM AES key inside `encryptOperatorBlob` and threw it away after encrypting the blob. On first chat after init, `chat.tsx` ran `requiredScopesForAgent(agentId)` which detected `telegram-secrets.encrypted` on disk and demanded the TELEGRAM scope key in the cached session. Missing → daemon auto-spawn refused → fall through to embedded mode → TG listener silently dropped with only a `note:` line. Operators only noticed when phone messages went unanswered. Fix: `runTelegramStep` now derives the scope key explicitly via `deriveBlobKey`, passes it as `precomputedKey` to `saveTelegramSecrets` (no redundant sign), and returns it to init.ts which appends to `operatorKeys` and re-writes `.operator-session` with all three scope keys (`keystore` + `anima-profile-v1` + `anima-telegram-v1`). Fresh-init agents now land in chat.tsx's Mode B (auto-spawn full gateway) instead of Mode C (degraded embedded). Zero added Touch ID prompts; the TELEGRAM derive already happened inside `encryptOperatorBlob` pre-fix, the wizard just discarded its output.

[0.24.3]: https://github.com/s0nderlabs/anima/releases/tag/v0.24.3

## [0.24.2] - 2026-05-14

### Changed

- **`anima init` cost summary now surfaces sandbox spend when deploy target is `sandbox`.** Pre-fix, the cost summary showed only the mainnet operator spend (mint + storage + agent infra float + compute ledger deposit) and silently omitted the 0G Sandbox Galileo testnet billing entirely, leaving operators guessing how much testnet 0G to fund and what the runtime burn rate looks like. New rows appear only for `deployTarget === 'sandbox'`: `initial provider deposit` (1 testnet 0G, $0.00 via faucet), `runtime burn` (0.09 0G/h, ~11h runway on a 1 0G deposit), `fund via faucet.0g.ai/?token=A0GI`, and `auto-topup agent EOA refills sandbox billing from compute ledger` so operators know the steady-state is hands-off.
- **Sandbox billing constants hoisted to `@s0nderlabs/anima-core`.** New exports `SANDBOX_BURN_RATE_OG_PER_HOUR = 0.09` and `SANDBOX_DEFAULT_INITIAL_DEPOSIT_OG = 1` replace inline magic numbers in `topup.ts` (was `0.09` in two places) and `sandbox-provision.ts` (was `?? 1`). Single source of truth so the wizard summary, the `anima topup --sandbox` runway hint, and the provisioning default never drift.

### Fixed

- **Stale `~0.07 0G/min` rate comment in `init.ts` deploy-target hint.** Was off by ~47x vs the canonical 0.09 0G/hour rate surfaced everywhere else; replaced with `~0.09 0G/h burn` to match the wizard's actual runway math.

[0.24.2]: https://github.com/s0nderlabs/anima/releases/tag/v0.24.2

## [0.24.1] - 2026-05-14

### Added

- **`/console` v2 envelope render.** Memory tab on `anima.s0nderlabs.xyz/console` now detects the v0.24.0 pack envelope after decryption and renders the root file plus a list of packed sibling files inline. Clicking a sibling swaps the body into the prose/source viewer. Slot 0 packs surface every `agent/*.md`; slot 3 packs surface every `user/*.md`. Closes the v0.24.0 follow-up (B14) where /console only showed the root field of packed slots. New helpers: `apps/web/lib/crypto/pack-blob.ts` (browser mirror of core), `unpackIfV2` convenience, `PackedSiblingList` component.

### Changed

- **Simplify pass over v0.24.0 surface.** Dropped dead `encodeRootOrPack` export (zero callers since v0.24.0 ship; the legacy-fallback escape hatch never landed). Dropped the dynamic `import('node:fs/promises')` inside `tryReadFile` in `memory-restore.ts` in favor of the top-level import already present. Web-side `unpackIfV2` helper moved from `MemoryBrowser.tsx` into `apps/web/lib/crypto/pack-blob.ts` so any future memory-rendering surface can reuse it.

[0.24.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.24.1

## [0.24.0] - 2026-05-14

### Added

- **Packed-blob memory slot envelope (v2 format).** Slots 0 (memory-index) and 3 (profile) now wrap their root file plus every sibling file in the partition into a single encrypted blob. Slot 0 packs `MEMORY.md` + every `agent/*.md` except `identity.md`/`persona.md` (which keep their own slots). Slot 3 packs `user/profile.md` + every other `user/*.md`. Result: every file the brain writes under `memory/agent/` or `memory/user/` now survives reprovision, cross-device handoff, and iNFT transfer (with correct purge semantics on the user side). Pre-fix only 6 files (the hardcoded `RESTORE_TARGETS` whitelist) anchored on chain; every other `user/<slug>.md` and `agent/learned-*.md` was local-only scratchpad that vanished on reprovision and left `MEMORY.md` with dangling references. New helpers: `packages/core/src/memory/pack-blob.ts` (encode/decode v2 envelope), `pack-gather.ts` (gather/write partition).
- **Backwards-compat detection.** `isV2Envelope` cheap byte sniff lets readers detect v2 vs legacy v1 raw markdown. Restore path unpacks v2 to the full partition tree; v1 stays single-file. 19 new unit tests cover round-trip, large packs (~100 files), unsafe filename rejection, and version-mismatch errors.

### Changed

- **`syncProfile` accepts pre-built plaintext** instead of reading from a file path. The slot-3 caller (`MemorySyncManager.doFlush`) now passes the encoded v2 pack bytes directly. Same operator-keyed encryption (PROFILE scope), same purge-on-transfer semantics.
- **`memory-restore.ts` unpacks slot 0 + 3 v2 envelopes on cold start.** Detects the envelope after decryption, writes root file + every entry in the `files` map to its path under `memory/agent/` or `memory/user/`. Legacy v1 path stays single-file.

### Fixed

- **Closes Issue 2 from the v0.23.x roadmap (RESTORE_TARGETS whitelist gap).** Operators no longer lose `user/operator-preferences.md`, `agent/learned-*.md`, or any other partition file on reprovision. `/console` PROFILE.md view now reflects the chain truth instead of just the canary seed.

[0.24.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.24.0

## [0.23.2] - 2026-05-14

### Changed

- **Brain consolidates operator facts into `user/profile.md`.** New `MEMORY_SAVE_GUIDANCE` rule pushes the brain to route "remember X about me" style facts to `name: "profile"` instead of inventing per-fact slugs like `user/operator-preferences.md` or `user/dark-mode-preference.md`. Only `user/profile.md` anchors to iNFT slot 3; every other `user/*.md` is local-only scratchpad until v0.24.0 ships the multi-file user partition. Pre-fix the brain spawned a new file per fact and operators saw `/console` show stale seed content despite a full session of `memory.save type=user` calls.
- **`memory.save` slug routing.** `toSlug()` now collapses profile-like names (`profile`, `preferences`, `about me`, `operator profile`, `user preferences`, `my preferences`, etc.) to the canonical `profile` slug when `type=user`. Compound types like `user-feedback` keep their existing behavior. `name=` still wins for genuinely distinct topics — only ambiguous "this is operator-intrinsic" names get consolidated.
- **`memory.save` profile.md merge semantics.** Subsequent saves to `user/profile.md` now dedup at line granularity instead of blindly appending. The line "Operator drinks coffee black" written 5 times across sessions ends up in the file exactly once. `appendBody` keeps the old behavior for non-profile slugs.

### Fixed

- **Gateway daemon version drift auto-detected on reattach.** When the operator upgrades the global CLI (`bun add -g @s0nderlabs/anima@0.23.2`) while a v0.23.1 daemon is still running, `anima` (chat) and `anima gateway start` now fetch `/healthz` over the unix socket, compare the running daemon's `version` field to the on-disk gateway package version, and if they drift: SIGTERM the daemon, clean the stale socket, and respawn. Operators no longer need to remember `anima gateway restart` after every upgrade. New helper: `ensureGatewayVersionMatchesCli` in `packages/cli/src/util/gateway-version.ts` with 5 unit tests covering ok / unreachable / drift / no-cli-version paths.

[0.23.2]: https://github.com/s0nderlabs/anima/releases/tag/v0.23.2

## [0.23.1] - 2026-05-14

### Changed

- **PROFILE key derivation folded into `anima init` wizard.** Operator signs twice in one sitting during init (keystore scope + profile scope, computed in parallel via `precomputeAllScopes`). The wizard caches both keys to `~/.anima/agents/<id>/.operator-session`, so the first chat does NOT re-prompt Touch ID and user-partition memory works out of the box without `anima profile init`. The previous v0.23.0 design required operators to run `anima profile init` as a follow-up command before user memory would ever anchor on chain.
- **`saveKeystoreLocally` + `encryptAgentKey` accept `precomputedKey`.** Init reuses the keystore scope key it just derived via `precomputeAllScopes` instead of doing a redundant second `signTypedData` for the same scope. Operator-facing sig count stays at 2 (keystore + profile) regardless of wallet backend.

### Fixed

- **`anima upgrade --reprovision` and `--in-place` now ship the cached PROFILE key.** Post-upgrade sandbox daemons start with `slots.profile` ready to anchor instead of `{ status: 'skipped', reason: 'no-profile-key' }`. Without the fix, every upgrade silently broke profile-slot anchoring until the operator re-ran `anima profile init`. New helper: `loadProfileScopeKeyHex(agentId)` in `packages/cli/src/util/profile-key.ts` mirrors the existing `loadTelegramHandoffSecrets` pattern.
- **`SandboxProvisionOpts` + `ResumeArchivedSandboxOpts`** now declare `profileScopeKeyHex?` so the field can thread through the existing secondary ECIES envelope into `handoffAgentToGateway`. `anima resume` benefits automatically the next time it's wired by a caller passing the key in.

### Deprecated

- **`anima profile init`** kept as a legacy escape hatch for agents minted before v0.23.1. v0.23.1 init wizards do everything that command did; v0.24.0 removes it.

[0.23.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.23.1

## [0.23.0] - 2026-05-14

### Added

- **`memory.list` brain tool.** Operator natural-language prompts like "show me all your memory" now have a deterministic target: the brain calls `memory.list` once, gets back the agent partition, user partition, AND chain slot status in a single call, then summarizes. Pre-fix the brain had to guess between `memory.read` and `fs.read` then walk paths manually, often resulting in partial answers or hallucination. New `MEMORY_LIST_GUIDANCE` in the frozen prefix bridges the prompt to the tool.
- **Operator-scoped PROFILE slot (slot 3).** The iNFT's `profile` IntelligentData slot is now wired end-to-end with operator-derived AES (HKDF over EIP-712 sig, scope `anima-profile-v1`), distinct from the agent-key slots (0/1/2/4/5). Profile is the user-partition blob: encrypted with the OPERATOR's key, not the agent's. Property: `iTransferFrom` purges the profile slot, so a new operator never inherits the prior operator's profile. The agent privkey alone cannot decrypt — only the current operator can. Wired through:
  - `restoreProfile` / `syncProfile` in `packages/core/src/memory/profile-sync.ts` (encrypt/decrypt/anchor)
  - `MemorySyncManager` includes profile in the batched `updateSlots` tx when a profileKey is present
  - `restoreMemoryFromChain` restores profile on boot when profileKey present, skips with `no-profile-key` otherwise
  - `GatewaySecrets.profileScopeKeyHex` shipped via the secondary ECIES envelope for sandbox handoffs
  - Local gateway entrypoint pulls the PROFILE scope key from the cached operator session (alongside `keystore` + `telegram`); `requiredScopesForAgent` now derives PROFILE whenever `user/profile.md` exists on disk
  - `anima sync` derives the PROFILE key alongside the keystore decrypt so a single CLI sync flushes everything
- **`anima profile init` CLI command.** Operator entry point: seeds `user/profile.md` if missing, derives the PROFILE scope key, then (sandbox) POSTs the key to `/admin/profile-key` or (local) runs a full sync that anchors the slot. Idempotent.
- **`/admin/profile-key` sandbox endpoint.** Operator-signed POST (EIP-191 over `adminTickHash('profile-key', ts, sandboxId)`) ships the 32-byte AES key into a running daemon. The runtime adapter exposes `setProfileKey` which updates the live `MemorySyncManager` AND fires a one-shot restore so the slot is on disk this turn — no daemon restart required.
- **`/healthz.slots` field.** Reports every IntelligentData slot's high-level status (restored / skipped / failed + reason + bytes). Operators (and `/console`) can probe what's anchored without parsing logs.
- **MEMORY.md synthetic index entries.** Boot-time restore now appends entries for `agent/identity.md`, `agent/persona.md`, and `user/profile.md` to MEMORY.md whenever those files exist on disk. Existing agents from pre-v0.23 get auto-backfilled the first time their daemon restarts on v0.23.0. New `ensureSyntheticIndexEntries` helper in `packages/core/src/memory/index-sync.ts`.

### Changed

- **`memory.read` / `memory.save` accept an `agentDir` override.** Gateway daemon registers them with `agentDir = ${TMPDIR}/anima-gateway/<id>` so memory tools resolve the same volatile dir the daemon writes to, not the legacy `~/.anima/agents/<id>/memory/`. Pre-fix the brain could `memory.save` to TMPDIR but `memory.read` would read from `~/.anima` and see stale content (or nothing). Path drift closed.
- **`MemorySyncManager` constructor accepts `memoryDir` + `profileKey` overrides.** Gateway passes both so `/sync` uploads the live TMPDIR snapshot, not the legacy on-disk copy.
- **`encryptOperatorBlob` accepts `precomputedKey`.** Previously required a live `OperatorSigner`; gateway daemon doesn't have one. The pre-derived key path now works alongside the live-sign path.
- **Bootstrap-placeholder hash skip in restore.** Slots that were minted with `keccak256('anima:bootstrap:<slot>')` (operator never uploaded a real blob) skip with `reason: 'bootstrap'` instead of looping the 3-attempt retry against a hash that will never resolve. Fixes the silent-restore failure mode where v0.22.x enigma's `identity` and `persona` slots chased the bootstrap hash for every boot.

### Fixed

- **Path drift between `memory.read/save` (agentPaths) and gateway-written files (TMPDIR).** See "Changed" above. Manifested as brain prose claiming "I don't have an identity.md" while the daemon was actively reading/writing to a TMPDIR copy of the file.

[0.23.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.23.0

## [0.22.2] - 2026-05-13

### Fixed

- **Brain em-dashes now stripped at the source (programmatic backstop).** v0.22.1 promoted the ASCII-hyphen rule to a HARD CONSTRAINT in the system prompt, but the qwen3.6-plus flagship still slipped em-dashes (U+2014) and en-dashes (U+2013) through on edge prompts. Added `sanitizeDashes()` in `packages/core/src/brain/sanitize.ts`, wired into `brain.infer` at the single return point in `og-compute.ts:380` so every surface (TUI, TG, A2A, market) sees clean text regardless of what the model emitted. Replacement rules: em-dash to comma+space, en-dash to ASCII hyphen. Defense-in-depth alongside the prompt rule.

[0.22.2]: https://github.com/s0nderlabs/anima/releases/tag/v0.22.2

## [0.22.1] - 2026-05-13

### Fixed

- **TUI statusbar now shows `perms: strict` when strict mode is set.** Previously the statusbar collapsed strict to `prompt` for display (`state.setApprovalsMode(next === 'strict' ? 'prompt' : next)` in chat-sandbox.tsx + chat.tsx) which left operators thinking they were in prompt mode when the gateway was actually denying every dangerous call. Mapping dropped; statusbar reflects the real mode in all three modes.
- **TG markdown tables now render readable on Telegram.** GFM `| col | col |` tables were sent raw to TG, which has no MarkdownV2 table syntax; pipes showed literally and columns drifted depending on TG client font. The plugin-telegram message formatter now detects GFM table blocks and wraps them in triple-backtick fences so TG renders them in monospace with the brain's space-padding preserved. New `wrapGfmTablesInCodeBlocks` helper at `packages/plugin-telegram/src/markdown.ts:168`.
- **TG tool-call double-message race eliminated.** Fast tools (e.g. strict-deny path where start+end events fire within ~5ms) used to race two parallel `bot.api.sendMessage` calls because the second event saw `messageId === null` before the first send's promise resolved. Result: a "tool starting" message followed by a duplicate "tool ended ✗" message instead of one in-place edit. Added a promise-chain lock (`flushLock`) in `ProgressTracker.push` and `ProgressTracker.finalize` so all flushes are serialized.
- **Brain ASCII-hyphen rule promoted to HARD CONSTRAINT.** Em-dash and en-dash compliance was previously a bullet under "Tone and style" the model occasionally slipped past. Moved to a dedicated `# HARD CONSTRAINTS (non-negotiable)` section at the top of the system prompt with concrete (correct → wrong) examples, the kind weak models actually internalize.

[0.22.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.22.1

## [0.22.0] - 2026-05-13

### Added

- **TUI markdown renderer now handles GFM tables.** Brain-emitted `| col | col |` blocks now render as aligned columns with a box-drawing divider under the header row instead of raw pipes. Single-column tables (`|---|`) are supported too. See `packages/cli/src/ui/markdown-parse.ts`.
- **Statusline shows `sandbox` billing reserve** alongside `wallet` and `compute` for sandbox-deployed agents. Polls every 30s, refreshes after every chat turn.
- **Per-turn lazy retry for memory-restore slots that failed at boot.** Transient 0G Storage indexer hiccups now self-heal on the next chat turn — `restoreMemoryFromChain` is fired (single-flight) before each `buildPrefix`, and identity/persona files are re-read from disk so recovered content lands in the brain's frozen prefix without a daemon restart.

### Changed

- **Statusline format unified.** New layout: `agent <name-or-id>  <full-EOA>  YOLO  ·  wallet X  ·  compute Y  ·  sandbox Z`. Drops the 0G Compute brain-provider address (operators never acted on it). Shows the registered `.0g` subname from `config.subname` when available; falls back to the 16-char agent ID hash. Uses the full agent EOA (no `shortAddr`) so chain explorers and auto-topup audits stay copy-paste friendly.
- **"YOLO" replaces "perms: off"** in the statusline when permission mode is `off`. Same underlying state, clearer label. Rendered in amber (`#fbbf24`).
- **System prompt now instructs the brain to use ASCII hyphens, not em-dashes** (U+2014 / U+2013). Project hard rule per global CLAUDE.md. Applies on every surface (TUI, Telegram, web).

### Fixed

- **TG bypass commands `/yolo`, `/perms`, `/reset` now actually fire from Telegram.** The channel envelope wrapping (`<channel source="telegram" ...>...</channel>`) was applied to inbound text BEFORE the bypass parser ran, and `parseBypassCommand` checks `startsWith('/')` — which the wrapped text doesn't. Now strips the envelope via the new `stripTelegramChannelEnvelope` helper before the bypass check. Brain dispatch still receives the wrapped text (channel context matters).
- **TG turns no longer override a globally-set yolo or strict permission mode.** Previously every TG turn unconditionally called `permission.setMode('prompt')`, so `/yolo` (off) or `/perms strict` had no effect during TG turns — modals appeared anyway. Now guards the override behind `previousMode !== 'off' && previousMode !== 'strict'`.
- **Boot-time memory restore now retries up to 3× per slot with 2s backoff** and surfaces failures via `console.warn` (visible in `anima-gateway.log`). Previously a transient 0G Storage indexer outage left identity/persona/MEMORY missing for the entire session with zero operator-visible signal — events.publish('log', ...) goes only to in-memory SSE subscribers which are zero at boot phase. Decryption failures also surface now.

### CI

- **`release.yml` smoke-test step busts `~/.bun/install/cache/@s0nderlabs` before each retry.** Earlier `bun install --frozen-lockfile` step warmed the packument cache BEFORE the publish steps; subsequent `bun add -g` reads cached packument and reports `No version matching <NEW>` indefinitely even though the registry has the version. Retries didn't help because bun re-reads the same poisoned cache. Manifests as v0.21.20 ("CDN-propagation-shaped failure") and v0.21.21 (3 retries failed identically). Diagnosed via local-peer collab, fixed in commit `3491c6b`.

### Internal

- New `stripTelegramChannelEnvelope(text)` helper exported from `@s0nderlabs/anima-plugin-telegram`. Lives next to its forward counterpart `formatTelegramChannel`.
- `MemorySyncManager` boot path captures failed slots into a `pendingRestoreFailed` flag + single-flight `lazyRestoreInFlight` promise. `buildPrefix` triggers a non-blocking retry on every turn when any slot is still failed.
- `chat-sandbox.tsx` now polls EOA + compute ledger + sandbox billing reserve directly from chain via `viem` + `getLedgerDetailReadOnly` + `getSandboxBillingReserve`. 30s interval, fires after every chat turn, cleaned up on exit.
- Test count +12 across `format.test.ts` (5 strip + bypass cases), `markdown.test.ts` (4 table cases), `memory-restore.test.ts` (3 retry cases), `frozen-prefix.test.ts` (1 em-dash rule case).

[0.22.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.22.0

## [0.21.21] - 2026-05-13

### Added

- **`anima --version` / `-v` / `version`** prints the CLI's installed version. Reads `package.json` via a path relative to the module so it works in dev workspace, `bun add -g` global installs, and Bun's per-project content store.

### Fixed

- **`anima --help` and `--version` no longer launch the TUI.** The argv dispatcher previously rewrote any first arg starting with `--` to the default `chat` subcommand (so `anima --yolo` worked as a shorthand). The side effect was that `anima --help` dropped into the chat REPL instead of printing help, and the `case '--help'` branch in the switch was unreachable dead code. The rewrite now excludes `--help` and `--version` as top-level commands.

### Internal

- `resolveCliVersion()` in `packages/cli/src/util/cli-version.ts` switched from `import.meta.resolve('@s0nderlabs/anima/package.json')` (which failed in monorepo workspace runs because the cli package has no `exports` entry for `./package.json`) to a direct `fs.readFile` of `../../package.json` relative to `import.meta.url`. Same output in installed mode, now works in dev too. Used by `--version` and by `commands/upgrade.ts` + `commands/init/sandbox-provision.ts` to pin the gateway npm install version.

[0.21.21]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.21

## [0.21.20] - 2026-05-13

### Changed

- **Sandbox bootstrap default flipped from `git` to `npm`.** Fresh `anima deploy` and `anima upgrade --reprovision` now install the harness via `bun add -g @s0nderlabs/anima@<version>` (~30-60 sec cold start) instead of cloning the monorepo from GitHub (~5-8 min). The npm path shipped in v0.21.15 as opt-in, was live-verified end-to-end on enigma (v0.21.16 ship report), and lived as opt-in for several releases before this flip — the path is exercised, the default is the only thing changing.
- **`ANIMA_BOOTSTRAP_REF` auto-implies git mode** when set without an explicit `ANIMA_BOOTSTRAP_MODE`. Preserves existing dev workflows ("deploy `main`", "deploy `<sha>`"). Explicit `ANIMA_BOOTSTRAP_MODE=npm` still wins.
- **Existing git-bootstrapped containers (specter local + enigma sandbox) are unaffected.** `anima upgrade` probes the container's filesystem (`probeContainerBootstrapMode`) and re-uses whatever mode the container was originally bootstrapped in. No surprise mode-flip on in-place upgrades.

### Internal

- New `resolveBootstrapMode(env)` helper in `packages/cli/src/util/bootstrap-mode.ts` consolidates env-var resolution. 7 unit tests cover default, explicit override, REF auto-imply, MODE-wins-over-REF, garbage MODE fall-through, and empty-string REF.
- `packages/gateway/src/bootstrap.ts` and `packages/gateway/src/upgrade-script.ts` defense-in-depth defaults flipped to 'npm' for consistency with `sandbox-provision.ts`.
- `packages/cli/src/commands/deploy.ts` error-tip language updated: "try forcing git mode (for unreleased commits): `ANIMA_BOOTSTRAP_MODE=git anima deploy`" (was: the inverse).

[0.21.20]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.20

## [0.21.19] - 2026-05-13

### Fixed

- **`anima upgrade --reprovision` now carries telegram secrets.** Previously the reprovision flow called `runSandboxProvision` without passing `telegramSecrets`, so freshly reprovisioned containers always booted with `listeners.telegram: "disabled"`. Operators had to manually re-pair the bot or fall back to `anima upgrade` (in-place) to restore the listener. Same gap closed in `anima deploy` (Local→Sandbox migration) and `chat-sandbox.tsx` auto-resume.
- **`anima upgrade --ref vX.Y.Z` works again on fresh `daytonaio/sandbox:0.5.0-slim` snapshots.** The bootstrap-mode probe was sending shell-conditional syntax (`if [ -d ... ]; then ...; fi`) to Daytona's argv-only exec endpoint, which couldn't interpret it and returned empty stdout → probe resolved to null → upgrade aborted with "cannot determine container bootstrap mode." Now wraps the probe in `bash -c '...'`, matching how `makeExecRead` and `buildGatewayRelaunchScript` already handle shell-syntax commands.

### Internal

- New `loadTelegramHandoffSecrets()` helper in `packages/cli/src/util/telegram-secrets.ts` consolidates the try/check/load/swallow pattern that previously lived copy-pasted in `upgrade.ts` (in-place), `resume.ts`, and the new reprovision/deploy/chat-sandbox sites. `chat.tsx` keeps its own loader for botUsername UX.
- 9 new unit tests across `telegram-secrets.test.ts` (3, helper round-trip/empty/error), `upgrade.test.ts` (5, probe command shape + parsing branches), and `init/sandbox-provision.test.ts` (1, `SandboxProvisionOpts.telegramSecrets` regression guard).
- `probeContainerBootstrapMode` is now exported so the wrap fix can be unit-tested directly without provisioning a real sandbox.

[0.21.19]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.19

## [0.21.18] - 2026-05-13

### Added

- **`anima transfer --oracle-key <hex>` flag** (and `ANIMA_ORACLE_PRIVKEY` env fallback). Unblocks back-transfers and any flow where the iNFT owner differs from the contract's `teeOracle()`. The supplied signer's address is validated against the on-chain oracle before any signing. Closes the v0.21.17 gap where `senderAddr != teeOracle` was a hard cancel.
- **`anima transfer` listed in `anima help`** with all flags.

### Fixed

- **`anima transfer` no longer false-fails on slow blocks.** v0.21.17 used viem's default `waitForTransactionReceipt` timeout, which was too short for 0G mainnet's variable block time and printed `iTransferFrom failed` while the tx had actually succeeded. Now uses the existing `waitForReceiptResilient` helper from anima-core (75 tries x 4s = 5 min budget). On true timeout, prints a `verify manually` note with the tx hash and a `cast tx` one-liner instead of a misleading failure.
- **Local agent dir cleanup only fires on confirmed-success receipt.** Prevents losing local state when the receipt poll times out on a successful tx.
- **Sweep tip in transfer outro** when sender was provided via raw-privkey flag/env, so operators who funded a throwaway wallet for a back-transfer get a `cast send` template to recover residual gas instead of stranding it.

[0.21.18]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.18

## [0.21.17] - 2026-05-13

### Added

- **`anima transfer <iNFT-ref> --to <addr>` CLI command.** Wires the previously unimplemented ERC-7857 `iTransferFrom` flow end-to-end: re-encrypts the keystore for the recipient, uploads the new blob to 0G Storage, signs the oracle proof, and atomically rewrites all 6 IntelligentData slots + transfers ownership. Memory slots (memory-index, identity, persona, activity-log) pass through unchanged because they're keyed off the agent privkey (stable across transfer); only the keystore slot is re-encrypted, and the profile slot is purged to its bootstrap placeholder by default (`--no-purge` opts out). Supports `--dry-run` (round-trip verifies the new keystore decrypt without chain writes), `--yes` (skip confirmation), and `--recipient-key <hex>` / `ANIMA_RECIPIENT_PRIVKEY` env (skip the recipient picker).
- **`@s0nderlabs/anima-core` exports** for the transfer building blocks: `transferProofPreimage`, `signTransferProof`, `buildTransferHashes` (in new `identity/transfer.ts`), `reEncryptKeystoreForRecipient` (in `identity/keystore-storage.ts`).
- **`AnimaAgentNFTClient.iTransferFrom()` + `teeOracle()`** methods (the ABI was already present; only the TS callers were missing).

### Internal

- 23 new unit tests across `transfer.test.ts` (proof preimage, oracle signing, hash building, A→B re-encryption round-trip) and `transfer.test.ts` for CLI argv parsing.

[0.21.17]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.17

## [0.21.16] - 2026-05-13

### Fixed

- **CI release smoke test path detection.** v0.21.15 publish succeeded but the post-publish smoke test failed (false positive) because it checked `~/.bun/install/global/node_modules/.bin/anima` for the CLI bin. Bun puts directly-installed package bins at `~/.bun/bin/<name>` and only transitive-dep bins at the `.bin/` dir. Smoke test now PATH-walks both directories and verifies all 7 published packages by package.json version. Also widens version verification to include the CLI package itself (was only checking gateway + 5 plugins). v0.21.15 is published correctly on npm; v0.21.16 just re-validates the path expectations CI checks.

## [0.21.15] - 2026-05-13

### Added

- **`npm`-mode sandbox bootstrap.** `bootstrap.ts`, `upgrade-script.ts`, and `relaunch-script.ts` now support an alternative install path that runs `bun add -g @s0nderlabs/anima@<version>` instead of cloning the monorepo from GitHub. ~30-60 sec cold start (vs 5-8 min for git mode). Opt-in via `ANIMA_BOOTSTRAP_MODE=npm anima deploy`. Git mode remains the default in v0.21.15 for zero-regression; npm becomes default in a follow-up.
- **`BootstrapMode` type** exported from `@s0nderlabs/anima-gateway` (`'git' | 'npm'`).
- **Relaunch script auto-detects bootstrap mode at runtime** by probing the container's filesystem (`$HOME/anima/.git/` for git mode, `$HOME/.bun/install/global/node_modules/.bin/anima-gateway` for npm mode). Backward-compatible: legacy git-bootstrapped containers keep working forever; new npm-bootstrapped containers also relaunch cleanly. Drops the hard `anima-dir-missing` failure that would have broken npm containers on archive/restore.
- **CLI probes container mode before in-place upgrade** via a single ~150-byte `execInToolbox` shell stanza, then ships the mode-specific upgrade script. Mode-aware post-flight version verification reads `package.json` from the correct path. Cross-mode upgrade (git↔npm) still requires `anima upgrade --reprovision`.
- **`findAgentBrowser` probes Bun's global install root** (`~/.bun/install/global/node_modules/.bin/agent-browser`) in addition to local `node_modules`. Browser tools resolve cleanly in npm-bootstrapped sandbox containers without PATH manipulation.
- **CI release-workflow smoke test** in `.github/workflows/release.yml`. After publish + metadata verification, the workflow now `bun add -g`s the just-published `@s0nderlabs/anima@<version>` into a temp dir and asserts the gateway bin + all 6 sibling packages installed at the matching version. Catches broken bin entrypoints + transitive resolution failures before customers hit them.

[0.21.15]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.15

## [0.21.14] - 2026-05-12

### Fixed

- **Memory sync sidecar makes a warm `/sync` truly a no-op.** Pre-fix, every `/sync` call ran the full `getIntelligentData` chain read at startup, then a second pass-through of every slot even when the activity-log + memory file plaintext hashes were unchanged since the last flush. Sidecar (`${dirname(activityLogPath)}/sync-state.json`) now persists the plaintext-hash map after each successful flush; init reads it first, falls back to chain hashes only when sidecar is missing. When sidecar populates every known slot, the chain RPC round-trip is skipped entirely. Second `/sync` is now empty across both specter and enigma surfaces.
- **Activity-log uploads gzip-then-encrypt, shrinking blobs ~4-5x.** A 1.7MB activity log now uploads as a 397KB AES-GCM blob. New `MEMORY_BLOB_VERSION_GZIP = 2` byte tags compressed blobs; v=1 plaintext blobs remain readable for legacy data. Cuts the Galileo-sandbox `/sync` 15-min timeout exposure proportionally.
- **AutoTopup `insufficient-wallet` events now suppress for 10 min instead of spamming every 60s.** Operator hit a 30+ event flood in the TUI when the agent EOA fell below the threshold. AutoTopup remembers the last `insufficient-wallet` failure timestamp and short-circuits subsequent poll ticks until the cool-down elapses; a successful wallet check clears the cool-down so a future drop refires immediately.
- **`memory.read` paraphrased queries hit a token-overlap fallback.** Brain frequently recalls memory titles with reordered or extra tokens (e.g. "tool test run" → "Tool test session"). Read tool now scores entries by non-stopword token overlap when exact + substring lookup miss; matches when at least half the query tokens appear in the entry's title+file+hook. New `read-tool-fallback.test.ts` covers the path.
- **`permission/service.ts` dangerous-pattern `allow-session` signature now keys on the pattern class, not the literal command.** One operator "Allow Session" approval on `rm -rf /tmp/foo` now covers all subsequent `rm -rf <path>` matching the same dangerous pattern, instead of re-prompting per unique path. Reduces approval fatigue without widening security envelope (operator still chooses `Allow Once` for one-shot authorization). Verified via custom test: 3 different `rm -rf` paths → 1 prompter invocation.
- **`browser.*` tools register on enigma sandbox.** `findAgentBrowser` now probes `cwd/anima/node_modules` in addition to `cwd` and `process.cwd()`, catching the case where the harness daemon boots from `$HOME` while the cloned repo (and `node_modules/.bin/agent-browser`) lives under `$HOME/anima`. Plugin loader resolves the binary once at register time and passes `binPath` through to each `make<Browser>` factory so per-call spawns don't re-search PATH.
- **`chain.tx` no longer skipped on operator-supplied hashes.** Added anti-skip guidance to the tool description; brain was previously inspecting the hash bytes and deciding it "looks fake" without calling the RPC. The RPC's `tx not found` is the operator-facing source of truth.
- **TG callback chain instrumented with diagnostic logs.** `[telegram] callback_query received/dropped/resolved` and `[tg-approval] prompter invoked / inline keyboard sent / resolver fired / timeout` log lines added to `listener.ts` + `build-runtime.ts`. Confirmed end-to-end approval flow works when click is delivered via real pointer events; synthetic JS `el.click()` on web TG inline keyboard buttons is silently dropped by the React handler, which masked the flow as "broken" in prior agent-browser drives.
- **`/sync` client timeout extended to 15 min** to accommodate large activity-log uploads on Galileo before the gzip shrink lands fully across deployments.

## [0.21.13] - 2026-05-08

### Fixed

- **TUI statusline `perms:` field now reflects gateway state, and `/yolo` + `/perms` + `/reset` work in sandbox-mode TUI.** Pre-fix the TUI thin client (`chat-sandbox.tsx`) hardcoded `approvalsMode: 'off'` at chat init and had no slash interceptors for `/yolo`, `/perms`, or `/reset`. Slash messages got shipped through `client.chat()` and the gateway's `dispatchBypass` correctly updated the server-side `PermissionService` (and the brain replied `"perms set to prompt"`), but the TUI's local `state.approvalsMode` signal never moved, so the statusbar stayed stuck at `perms: off` for the entire session even after toggling. Cosmetic, not a security issue (the gateway's PermissionService — not the TUI display — gates the actual approval modal), but it broke the demo story. Fix: `/healthz` now exposes `permsMode: 'off' | 'prompt' | 'strict'` (gateway-side, plumbed through `RuntimeAdapter.permissionMode?()` on `RealRuntime` returning `runtime.permission.getMode()`); `chat-sandbox.tsx` reads `health.permsMode` to seed the chat state on init AND adds local handlers for `/yolo`, `/perms`, and `/reset` that forward through `client.chat()` (so the gateway's bypass dispatcher still owns the source of truth) AND re-fetch `/healthz` to sync the local statusbar. Closes the v0.21.5+ regression filed in `feedback-tui-statusbar-stale-perms-thin-client.md`.

## [0.21.12] - 2026-05-07

### Fixed

- **Gateway boot path now revalidates required scope keys before skipping Touch ID; daemon fails loud when a half-configured runtime would result.** Operator hit "specter TG isn't responding" tonight after running `anima gateway start` against a session written by a prior path that only derived the `keystore` scope. The session was timestamp-fresh so `isOperatorSessionFresh` returned true, the unlock step was skipped, and the daemon booted with no `telegram` scope key. `local-entrypoint.ts:loadLocalTelegramSecrets` then returned `undefined` silently (the only signal was a stderr line that vanished when the detached daemon's tty closed), the telegram plugin's `register()` bailed because `secrets?.telegram` was falsy, no listener was registered, and every inbound TG message was dropped. Five releases (v0.21.5 → v0.21.10) shipped quietly broken on this code path because every prior verification of `[telegram] listener active` happened via TUI auto-spawn or `anima gateway run` first-boot, never via the bare `anima gateway start` restart cycle. v0.21.5's CHANGELOG explicitly disclaimed any behavior change to `gateway start` and that disclaim turned out to leave a hole. v0.21.12 closes it across both boot paths and adds three new defenses so the same shape of bug can't form again. New `requiredScopesForAgent(agentId)` core helper inspects on-disk state (always 'keystore'; adds 'telegram' when `telegram-secrets.encrypted` exists, etc.); new `isOperatorSessionComplete(agentId, required)` returns true only when a non-expired session contains every required key. `anima gateway start` now uses these helpers to decide whether to re-derive via Touch ID, never just timestamp-freshness. The TUI auto-spawn path in `chat.tsx` mirrors the same enforcement, with a clear hint when scope keys are missing telling the operator to run `anima gateway start` interactively. The daemon's `loadLocalTelegramSecrets` exits 1 with a clear error BEFORE the socket is opened when `telegram-secrets.encrypted` exists but the session lacks the TELEGRAM scope, so `anima gateway start`'s wait-for-socket-readable check fails fast and the operator sees the failure at boot. `/healthz` now exposes `listeners.telegram: 'active' | 'disabled' | 'failed'` so operators (and the live verification matrix) can probe listener wiring without parsing logs. `spawnGatewayDaemon` now redirects daemon stdout+stderr to `~/.anima/agents/<id>/gateway.log` (truncated each boot) by default, so detached daemon diagnostics survive the parent CLI's exit (the missing piece that made tonight's debugging painful). Closes the architectural intent that any gateway boot path produces identical behavior. See `feedback-gateway-restart-must-revalidate-scopes.md` in memory for the full incident report.

## [0.21.11] - 2026-05-07

### Fixed

- **CI release pipeline pre-pins workspace deps + verifies published metadata.** Operator hit `Export named 'adminTickHash' not found in module '@s0nderlabs/anima-gateway'` after `bun install -g @s0nderlabs/anima@latest` on May 7 evening. Investigation showed every release v0.21.5 → v0.21.10 published broken metadata: `npm view @s0nderlabs/anima@<version> dependencies` reported every `@s0nderlabs/anima-*` sibling pinned at `0.21.4` (the version when `bun publish`'s workspace:* rewriter last worked correctly), even though local source + lockfile + on-disk packages were all at the correct version. Five releases in a row shipped silently broken; nobody noticed because dev sessions run from workspace source, not npm. The fix stops trusting `bun publish`'s built-in workspace:* substitution: a new "Pin workspace deps" step in `.github/workflows/release.yml` walks every `packages/*/package.json` and replaces `workspace:*` cross-deps with the literal current version BEFORE any `bun publish` runs. A new "Verify published deps" step at the tail fetches each just-published tarball directly from `registry.npmjs.org/<pkg>/<version>` (bypasses npm view's cache) and asserts every `@s0nderlabs/anima-*` dep equals the just-published version. If any mismatch, CI fails loud. The `/seal` skill (`~/.claude/commands/seal.md`) gains a parallel post-CI Step 7d as belt-and-suspenders. See `feedback-bun-publish-workspace-dep-stale.md` in memory for the full incident report.

## [0.21.10] - 2026-05-07

### Fixed

- **Sandbox runtime config now carries `identity.operator` + `deployTarget: 'sandbox'`.** v0.21.9 verification on enigma surfaced that `account.balance` returned `sandboxBillingReserve: null` even though enigma is sandbox-deployed. Root cause: provision envelope's `runtimeConfig` from `handoffAgentToGateway` didn't include the operator address or deployTarget, so `buildAnimaRuntime` defaulted both to undefined/'local' and the brain context never met the `ctx.deployTarget === 'sandbox' && ctx.operatorAddress` precondition for the billing reserve lookup. Fix is server-side in the gateway: `/bootstrap/provision` now enriches the inbound config with `operator: request.operatorAddress` (already verified via EIP-191 sig) and forces `deployTarget: 'sandbox'` (the harness only ever runs in sandbox). Single point of fix for all current + future provision paths; no client-side change needed. Re-verified live on enigma.

## [0.21.9] - 2026-05-07

### Added

- **`anima balance` CLI command — full economic position aggregator.** Operator-facing read-only command that prints EOA mainnet + EOA testnet + compute ledger total/available/locked + per-provider envelope breakdown + sandbox billing reserve (when sandbox-deployed) in one round-trip. No agent unlock required. Closes the v0.21.9 balance-under-counting incident where `account.info` returned a single `computeLedger0G` number (no available/locked split, no sandbox billing reserve) and operators were under-reporting positions by ~10x. Live-verified on specter: shows `1.158 EOA + 6.818 ledger total (0.087 available + 6.731 locked) = 7.976 0G mainnet` with auto-topup wallet-low warning when EOA below 2 0G threshold.
- **`account.balance` brain tool.** Sibling to `account.info`. Returns the full balance picture (same shape as `anima balance` output) so the brain can answer "what's my full balance" / "show full position" / "how much do we have" without operator running CLI. Wired into `ONCHAIN_GUIDANCE` with a one-liner directing brain to call `account.balance` for top-line aggregation and `chain.balance` for per-token detail.
- **`anima admin autotopup-tick` CLI command.** Operator-only ops endpoint that live-fires the AutoTopupManager poll cycle (skips the 5-min wait). Two paths: (1) local mode curls the gateway unix sock (trustLocal=true via 0600 perm); (2) sandbox mode signs payload with operator wallet via EIP-191 and POSTs to the sandbox HTTP endpoint. Live-verified `{ok: true}` against specter local sock; sandbox path closes Task #366.

### Changed

- **`POST /admin/autotopup/tick` accepts EIP-191 signed body when not trustLocal.** Sandbox endpoint (reachable via public nip.io URL) now verifies `{ ts, signature }` body via new `adminTickHash` + `verifyAdminTickSig` in `packages/gateway/src/auth.ts`. Sig is bound to action='autotopup-tick' + ts (±5min window) + sandboxId so a chat sig can't be replayed against admin and an admin sig for one container can't fire on another. Local trustLocal path unchanged. Pre-provision request returns 500 (operator-not-set) instead of 401.

### Fixed

- **Closes Task #366** — `anima admin autotopup-tick` now fires successfully against enigma sandbox endpoint with EIP-191 auth (verified with the new SandboxClient.triggerAutoTopupTick + signed body path).

## [0.21.8] - 2026-05-07

### Fixed

- **Brain anti-skip clause for tool calls under `/perms prompt` mode.** May 7 PM v0.21.7 deferred-cell drive surfaced two reproducible hallucinations on TUI enigma where the brain SKIPPED a tool call to avoid an approval modal and instead fabricated a plausible inline answer. Case 1: prompt "use shell.run to print the date" under `/perms prompt` → brain replied "Current date and time: Thu May 7 08:09:12 UTC 2026" with `toolCalls=0` and NO modal fired. Case 2: prompt "use shell.run to execute echo modal-test-n-1778143000" under `/perms prompt` → brain replied "Output: modal-test-n-1778143000 (exit 0)" with `toolCalls=0` and NO modal. v0.21.8 generalizes the v0.21.6 memory.save anti-hallucination clause to ALL tools: appends a CRITICAL anti-skip clause to `DEFAULT_SYSTEM_PROMPT` directly under "Tool use (REQUIRED)". The clause cites the verbal cues the brain typically uses to fake execution ("output:", "exit 0", "returned", "✓", "done", "the date is", etc.) and explicitly tells the brain to fire the tool under EVERY permission mode (off/prompt/strict) — letting the modal handle approval rather than skipping the call. Why it matters: under `/perms prompt`, an operator might ask anima to send a real action (transfer, message, write) and the brain would echo back "✓ done" without actually doing anything — same hallucination shape as the v0.21.6 memory.save claim-without-call but for any side-effecting tool.

## [0.21.7] - 2026-05-07

### Fixed

- **Brain deferred-load awareness for `browser.*` tools.** May 7 PM matrix verification surfaced a brain hallucination: when `browser.*` schemas weren't in the default tool enum (deferred-load to save tokens) and the operator asked for web content, the brain replied "browser tools aren't registered in this environment" instead of calling `tool.search('browser')` first to load schemas on demand. Live evidence on TG enigma, even though `tool.search('browser')` correctly returned 4 browser tools when invoked manually. v0.21.7 appends a "**Deferred-load awareness**" clause to BROWSER_GUIDANCE in `frozen-prefix.ts` directing the brain to call `tool.search('browser')` FIRST when browser tools don't appear in the default list, before claiming they're unregistered. They ARE registered when the runtime has Chromium available; tool.search reveals them on demand.
- **`findAgentBrowser` falls back to `node_modules/agent-browser/bin/agent-browser.js` direct.** Defends against a bun-install/harness-boot race where `bun install` finishes extracting the `agent-browser` package but hasn't yet linked the `node_modules/.bin/agent-browser` symlink, causing plugin loader's `isBrowserAvailable()` to register zero browser.* tools at boot. New 5-line fallback path checks the package's own bin script directly when the `.bin/` symlink is absent.

## [0.21.6] - 2026-05-07

### Fixed

- **Brain anti-hallucination clause for `memory.save` claim-without-call.** During the May 7 PM 4-surface verification matrix, TG enigma brain replied `"Already noted that you prefer dark mode in general. I've updated it to include t..."` to the prompt `"remember that I prefer dark mode for matrix testing"`, but only `memory.read` fired — no `memory.save` tool-call landed in `activity.jsonl`. The same prompt fired `memory.save` correctly on TUI specter. v0.21.6 appends a CRITICAL anti-hallucination clause to `MEMORY_SAVE_GUIDANCE`: if the reply asserts a save (any of "noted", "saved", "remembered", "I've updated memory", "got it, I'll remember"), the brain MUST call `memory.save` in the same turn — even if a prior `memory.read` showed a similar fact. Closes the claim-without-call gap surfaced by the v0.21.5 verification.

## [0.21.5] - 2026-05-07

### Fixed

- **`anima` (no args) auto-spawns the gateway daemon when no sock is present.** Pre-fix, `chat.tsx` checked `existsSync(gateway.sock)` and fell through to embedded TUI mode if absent. Embedded mode silently disabled (a) Telegram pairing-store wiring (no inbound delivery — listener logs `[telegram] no allowlist configured AND no pairing store. All inbound messages will be DROPPED.`) and (b) AutoTopupManager polling (envelope can starve invisibly). v0.21.5 adds an auto-spawn path that, when no sock is present and a fresh operator session exists, spawns `anima-gateway-local` as a detached child via the new shared `spawnGatewayDaemon` helper, polls for the sock for up to 12 seconds, and attaches as thin-client. `ANIMA_FORCE_EMBEDDED=1` keeps the legacy embedded path available for tests / debugging. When session is stale (24h TTL expired), prints a hint to run `anima gateway start` and falls back to embedded mode. Companion: `gateway-start.ts` refactored to share the same helper (no behavior change for `anima gateway start`). 4 unit tests in `packages/cli/src/util/gateway-spawn.test.ts`.

- **Gateway boot proactively reaps stale Telegram bot-token locks.** Pre-fix, if a previous gateway crashed or got SIGKILLed, its `~/.anima/locks/telegram-bot-token-<hash>.lock` file remained valid until TTL expiration, causing the new gateway's `TelegramListener.start()` to enter `scheduleStartRetry`'s 30s × 12-attempt waltz (~6 minutes of TG silence). v0.21.5 calls a new `clearStaleTelegramTokenLock(botToken, {agentId})` helper between secrets-load and gateway-PID-lock-acquire in `local-entrypoint.ts`. The helper reuses the existing `isStale` logic (PID-dead via `process.kill(0)`, zombie-detection via `/proc/<pid>/status`, TTL eviction) and only deletes locks that are demonstrably abandoned — never a lock held by a live foreign PID. Logs a single line on cleanup so operators see what happened. 4 new tests in `packages/plugin-telegram/src/recovery.test.ts`, 5 new tests in `packages/core/src/locks.test.ts`. Generic underlying primitive `clearStaleScopedLock` exported from `@s0nderlabs/anima-core` for any future stale-lock cleanup needs.

### Changed

- **`anima topup --sandbox <amount>` is the canonical flag for SandboxBilling deposits.** v0.17.1 introduced `--provider <amount>` for Galileo testnet billing deposits, but the name collided with "compute provider" envelope (the brain provider address), causing operators to think `--provider 1` would top up the compute envelope. v0.21.5 renames the canonical flag to `--sandbox` and the interactive picker label to "Sandbox billing deposit (Galileo testnet runtime fees)". `--provider` continues to work as a backwards-compat alias with a deprecation warning printed on use; passing both `--sandbox` and `--provider` errors with a "pick one" message. Internal mode discriminant in `topup.ts` renames `'provider' → 'sandbox'`. `parseAmount` error string + CLI help text updated to mention both flags. README runbook strings (`sandbox-provision.ts:919`) updated to use `--sandbox` going forward.

- **AutoTopupManager wakes the brain broker eagerly on its first null-ledger tick.** Pre-fix, `getLedger()` returned null until `brain.init()` ran (lazy on first `infer()`). An idle agent (no chat turns) would see the manager poll a null ledger every 60s — emitting `topup-skipped: broker-not-ready` 14× over 12 minutes was the actual v0.21.4 enigma symptom. v0.21.5 adds a new optional `getBrainInit?: () => Promise<void>` injection. When `getBrokerLedger()` returns null AND `getBrainInit` is wired (gateway path always wires `() => brain.init()`), the manager calls init once and re-checks. `brain.init()` is idempotent (early-returns if `this.broker` is set). Init failures surface as `topup-skipped` with `reason: 'broker-not-ready'` + `initError` field for diagnostic visibility. Legacy callers without `getBrainInit` preserve the v0.21.4 broker-not-ready skipped behavior. 4 new unit tests covering wake / failure / no-op / legacy paths.

### Added

- **`POST /admin/autotopup/tick` admin endpoint** for live-firing one autotopup poll without waiting for the 5-minute interval. Used by the v0.21.5 verification matrix to deterministically trigger `topup-fired` events on demand. Currently gated to `trustLocal` mode only (unix-sock 0600 perm = auth); sandbox-side EIP-191 auth is post-MVP scope. Returns `200 {ok:true}` on a successful tick (event flows through existing event/activity-log surfaces, NOT the return value), `503 {ok:false, reason:'autotopup-disabled'}` when the runtime has no AutoTopupManager (economy.autoTopup disabled or brain.provider unset), `409 {state}` when the runtime isn't Ready yet, `401` from sandbox mode. New `triggerTopupTick?(): Promise<TriggerTopupTickResult>` on `RuntimeAdapter`; implemented in `RealRuntime`, `StubRuntime` skipped (returns 501). 5 new tests in `packages/gateway/src/server.test.ts`.

## [0.21.4] - 2026-05-07

### Fixed

- **`anima topup` CLI rejects bad amounts with a clear error.** Pre-fix, passing an Ethereum address as a flag value (e.g. `anima topup --provider 0xADDR --amount 1`) silently coerced the address through `Number()`, producing ~`8.74e+47` which then fed into viem's `parseEther` and threw an opaque "Number 8.74510097402409e+47 is not a valid decimal number" deep inside the deposit flow AFTER on-chain side effects had partially executed. v0.21.4 validates each `--agent` / `--compute` / `--provider` argument up front: must be a finite positive number ≤ 1e6 0G; otherwise prints a usage hint pointing at the correct syntax (`flag <amount-in-0G>`, not `flag <address>`) and exits with code 2 before any chain RPC fires.
- **Brain hint string for `LedgerInsufficientError` matches the actual CLI.** Pre-fix, the error suggested `anima topup compute --amount 2` (no such command); v0.21.4 corrects it to `anima topup --compute 2` (the actual flag).

### Changed

- **AutoTopupManager now emits `topup-skipped` events** when a tick can't proceed (broker not yet initialized at gateway boot, RPC failure on wallet balance read, RPC failure on provider envelope read). Pre-fix, these silent returns meant operators couldn't tell the difference between "manager isn't running" and "manager is running but waiting for the brain to spin up." Now every silent path produces an `auto-topup` activity-log entry with `kind:'topup-skipped'` and a `reason` field (`broker-not-ready` / `wallet-rpc-error` / `provider-rpc-error`). New `'topup-skipped'` kind added to `AutoTopupEventKind`; existing 1 unit test updated.

## [0.21.3] - 2026-05-07

### Changed

- **Auto-escalation now covers ANY web.fetch hiccup, not just bot-blocks.** v0.21.2 escalated only when `data.blocked === true`. Live drives showed Qwen3.6 still struggled when `web.fetch` returned `ok:false` for a transient reason (HTTP 5xx, 429, timeout, DNS, connection refused, generic fetch error): brain would acknowledge the failure in the user-visible reply instead of trying the browser primitive. v0.21.3 escalates on `result.ok === false` UNLESS the error matches a permanent-failure pattern (`invalid URL`, `unsupported protocol`, `host blocked` for security). Browser routing is now active for **every** transient hiccup. New `classifyError()` helper maps the raw fetch error into a short symbolic reason (`timeout` / `http-503` / `dns` / `connection` / `aborted` / `fetch-error`) so the brain sees a clean tag in `auto_escalation.reason` instead of a stack trace. `merged.data.auto_escalation.original_error` preserves the raw fetch error for debugging. 8 new unit tests covering each transient + permanent path.

## [0.21.2] - 2026-05-07

### Fixed

- **Brain auto-escalation when web.fetch returns blocked:true (R1, deferred from v0.20.2-followup, task #346).** When `web.fetch` returns a structured bot-block signal (Cloudflare interstitial, Google search block, captcha, rate-limit, etc.), the dispatcher now AUTOMATICALLY retries via `browser.navigate` on the same URL before returning to the brain. Pre-fix the v0.20.2 frozen-prefix rule "if blocked, escalate to browser.navigate" was prose-only and Qwen3.6 ignored it in long contexts, leaving the operator with "(no reply)" on TG or a memory disclaimer on TUI. Now the brain wrapper sees a merged tool result with both the original blocked response AND the escalated browser.navigate result; it can call `browser.snapshot` next without ever having to notice the failure. Activity log gets two `tool-call` entries with the escalation tagged `autoEscalated:true`. SSE events fire for both so TG operators see the escalation chain (TUI thin-client renders ↪ / ↳ instead of ⏺ / ⎿). New shared helper `packages/core/src/tools/escalation.ts` (12 unit tests + 1 integration script `test/local/e2e-fetch-escalation.ts`); wrapper changes in `chat.tsx` (TUI direct) and `build-runtime.ts` (gateway / TG) keep activity log + SSE + brain message in sync.

## [0.21.1] - 2026-05-06

### Fixed

- **Brain content fallback for Qwen reasoning_content drift.** When the 0G broker (Qwen3.6) returns `content: ""` but `reasoning_content` is non-empty (model "thinking mode" failed to transition out cleanly), the brain wrapper now falls back to `reasoning_content` after stripping any `<think>...</think>` wrappers. Pre-fix the user saw "(no reply)" on TG even though `usage.completionTokens > 0`. New `stripThinkBlocks()` + 6 unit tests.
- **Brain malformed tool_call envelope guard.** When a tool_call comes back with empty `function.name` or truncated `function.arguments` JSON, the brain loop now injects a corrective tool-result message ("envelope was malformed, re-emit cleanly") instead of dispatching a broken call to the registry. Pre-fix the dispatch failed with `Unknown tool: `, the brain spiraled, and the user saw "sorry, something went wrong on my side". Mirrors the existing `recoveredFromSafetyBlock` pattern. New `looksLikeValidJsonString()` + 6 unit tests. Live-observed root cause: enigma activity entry ts=1778075012156 showed `{"name":"","args":"{\"query\": \"browser navigate\""}` (truncated raw JSON, missing closing brace). Non-deterministic Qwen quirk; retry usually works because random seed differs.

## [0.21.0] - 2026-05-06

### Added

- **Auto-topup: agent funds its own compute bills.** New `AutoTopupManager` (`packages/core/src/economy/auto-topup.ts`) polls the per-provider compute envelope every 5 minutes (configurable). When the envelope drops below `compute.lowThreshold` (default 0.5 0G), the manager calls `broker.ledger.depositFund(amount)` followed by `broker.ledger.transferFund(provider, amountWei)` signed by the agent's private key. The operator pays nothing — this is the mechanism that lets a paused-and-restarted agent keep itself running on its own balance. Hard cap: 5 successful topups per envelope per UTC day. Refuses topup when wallet would dip below `wallet.minRetainedAfterTopup` (default 0.1 0G gas buffer). Wallet-low notification fires once when the agent EOA crosses `wallet.notifyThreshold` (default 2.0 0G) downward. All actionable changes flow as `auto-topup` events on the gateway EventHub + `auto-topup` activity-log entries; TUI thin-client renders ⚡ topup / ⚠ wallet / ✗ topup system rows. Configurable via `economy.autoTopup` in `anima.config.ts`. Default-on; set `enabled: false` to disable. 9 new unit tests.
- New `getLedger()` accessor on `OGComputeBrain` so the auto-topup manager can read the broker's ledger surface using the same wallet binding as the brain. Returns null until `init()` runs.
- New `'auto-topup'` event kind on the gateway EventHub and `'auto-topup'` activity-log entry kind.

### Changed

- `BuiltRuntime` now exposes `autoTopup: AutoTopupManager | null` so the gateway shutdown path can stop the manager cleanly. The manager is constructed and started after `brain.init()` and stopped in `dispose()` before listener teardown.

## [0.20.2] - 2026-05-06

### Fixed

- **`web.fetch` now returns a structured `blocked: true` signal** when the response body matches a known anti-bot interstitial (Cloudflare "Just a moment...", Google's "unusual traffic from your computer network", DuckDuckGo anomaly captcha, Bing verify, generic g-recaptcha/h-captcha, Akamai/Imperva/Datadome/PerimeterX bot interstitials) OR when status is 429/451 (rate-limit) OR when status is 403 from a search-engine domain. Brain has unambiguous routing data instead of trying to interpret garbage HTML markdown. Pattern check scans first 4KB of body for speed; trailing harmless content does not trigger.
- **`browser.navigate` escalation rule added to frozen-prefix DEFAULT_SYSTEM_PROMPT.** When `web.fetch` returns `blocked: true` or an empty/near-empty body, brain MUST immediately call `browser.navigate` on the same URL or comparable source. Forbidden: answer-from-memory, "search engines are blocked, here's what I know from training", asking the operator "should I use browser instead". The browser path runs in a real headless Chromium that bypasses bot-blocks. This closes the v0.20.1 demo regression where a "browse about subquadratic" prompt resulted in 7 blocked fetches followed by a memory-derived answer.
- **`onCompactionEvent` now flows through the gateway** (real-runtime.ts TUI path + build-runtime.ts TG path). Brain emits the event when compaction folds older history; gateway publishes to `EventHub` ("context-compacted") and to the activity log. TUI thin-client subscribes and pushes a `✂︎ context compacted N → M messages (~K tokens)` system row. Pre-fix v0.20.0 wired the brain-level event but never propagated it past the gateway, so the TUI never displayed compaction.

### Added

- New `'context-compacted'` event kind on the gateway `EventHub` and a corresponding `'context-compacted'` activity-log entry kind. Both carry `{ channelKey, from, to, promptTokens }`.
- 9 new `web.fetch` block-detection unit tests in `packages/plugin-system/src/web-fetch.test.ts` (16 tests total, was 7).

## [0.20.1] - 2026-05-06

### Fixed

- **TUI thin-client now intercepts `/yolo`, `/perms`, `/reset` bypass commands.** v0.20.0 wired the bypass interception in `build-runtime.ts` for the TG dispatch path, but the TUI thin-client routes through `real-runtime.ts` `runChatTurn` for the gateway-local mode (post-v0.19.0 architecture), which had no bypass interception. Effect: typing `/perms strict` in the TUI sent the literal string to `brain.infer`, which produced an English-language acknowledgment ("Permission mode set to strict") without actually mutating the `PermissionService`. Status bar still showed the original mode. Fix: added `dispatchBypass(bypass, runtime)` mirror of `dispatchTelegramBypass` in `real-runtime.ts:75`, runs BEFORE `brain.infer` so bypass commands operate without burning compute. Wires `applyYolo` / `applyPerms` from `@s0nderlabs/anima-core`.

## [0.20.0] - 2026-05-06

### Added

- **TUI slash autocomplete popup.** Typing `/` in the TUI now opens a menu of every command available on that surface, sourced from a shared registry (`@s0nderlabs/anima-core` `COMMAND_REGISTRY`). Up/Down to cycle, Tab/Enter to commit, Esc to dismiss. Mirrors the approval-modal layout pattern (flexShrink=0, scrollbox compresses to make room). Pulls Claude Code commands from the loaded `commandIndex` into the same suggestions.
- **TG client autocomplete via `setMyCommands`.** Listener now registers the bot command list with Telegram on start (`bot.api.setMyCommands(buildTelegramCommands(), { scope: { type: 'default' } })`). Operators typing `/` in any TG client see the bundled command menu populated, no more BotFather-default empty.
- **`/yolo` and `/perms` commands available on TG.** Operators flip approval mode from their phone: `/yolo` toggles between off and prompt; `/perms <off|prompt|strict>` sets explicitly; `/perms` no-arg shows current. Plumbing via extended `BYPASS_COMMANDS` + new `dispatchTelegramBypass` helper that runs BEFORE brain.infer in both gateway path (`build-runtime.ts`) and local-mode (`chat-telegram.ts`).
- **`/perms` and `/reset` in TUI.** `/perms <mode>` parallels TG semantics. `/reset` calls `brain.clearChannel('tui:stdin')` and pushes a system row so the operator sees the channel cleared.
- **Per-channel brain history.** `OGComputeBrain.history` is now a `Map<channelKey, BrainMessage[]>`. Channel keys: `'tui:stdin'`, existing TG sessionKey (`agent:<name>:telegram:dm:<chatId>` etc), `a2a:<peer>` for A2A drains, `'marketplace'` for marketplace events, `'default'` fallback. New `clearChannel`, `getChannelHistory`, `setChannelHistory`, `listChannels` methods. TUI conversations no longer interleave with TG conversations.
- **Auto-compaction at token threshold.** Pre-flight check on every `infer()`: when running estimate (max of last-turn `usage.promptTokens` and chars/3.5 heuristic) exceeds `threshold * contextWindow`, summarize older messages via a fresh sub-call (no tools, dedicated `SUMMARY_SYSTEM_PROMPT`) and replace history with `[summary, ...keepRecent]`. Defaults: threshold 0.5, contextWindow 1_000_000 (Qwen 1M target), keepRecent 8 turns. Frozen prefix is never touched, prefix-cache stays warm.
- **Conversation persistence** (default on). Every committed turn is appended to `~/.anima/agents/<id>/conversations/<sanitizedKey>.jsonl` with fsync. On boot, `OGComputeBrain.init()` rehydrates channel histories. Off-switch via `config.brain.persistConversations: false`. Compaction performs an atomic rewrite (write-tmp + rename) so the on-disk state mirrors the in-memory state.
- **`BrainCompactionEvent` + `onCompactionEvent` callback** on `BrainInferInput`. TUI subscribes and pushes a system row "✂︎ context compacted (N → M messages, ~K tokens)" so the operator sees compaction fire.
- New configurable `brain.maxOutputTokens` (default 4096, was 1024 hardcoded), `brain.contextWindow` (default 1_000_000), `brain.compaction` (`{ threshold?, keepRecent? }` or `null` to disable), `brain.persistConversations` config fields.
- New shared command registry at `packages/core/src/commands/registry.ts` with `COMMAND_REGISTRY`, `commandsForSurface`, `findCommand`, `parseSlash`, `suggestForPrefix`. Single source of truth consumed by both the TUI menu and the TG `setMyCommands` payload.
- New compaction module at `packages/core/src/brain/compaction.ts` with `estimateTokens`, `shouldCompact`, `compactHistory`, `SUMMARY_SYSTEM_PROMPT`, `DEFAULT_COMPACTION_OPTS`.
- New persistence module at `packages/core/src/brain/history-persist.ts` with `createFsHistoryPersist`, `sanitizeChannelKey`, `HistoryPersist` interface (`loadAll` / `appendTurn` / `clearChannel` / `rewriteChannel`).

### Changed

- **`OGComputeBrain.history` is now per-channel.** Existing single-history callers continue to work via the `'default'` channel; `opts.history` constructor seed still flows there. New code should pass `BrainInferInput.channelKey` and use the channel API.
- **Default `maxOutputTokens` bumped from 1024 to 4096.** No turn ever requested 4096 in practice; the bump removes a silent ceiling that capped agent verbosity.
- **`parseBypassCommand` returns `{ command, args }` instead of `BypassCommand | null`.** Args are now exposed so handlers (especially `/perms <mode>`) can read the full message. Existing callers in `chat-telegram.ts` updated; the `dispatchTelegramBypass` helper in build-runtime.ts mirrors that path for the gateway dispatcher.
- **`/reset` (TG) actually resets.** Previously replied "context is fresh per TG turn already" — a lie because the in-memory history was shared across turns. Now calls `brain.clearChannel(input.sessionKey)` and replies "conversation reset (this chat's history cleared)."
- **All 11 `brain.infer` call sites** pass an explicit `channelKey` so each surface has its own history partition.

### Fixed

- **TUI ↔ TG history bleed.** Pre-v0.20.0 the same `OGComputeBrain` instance kept one shared `this.history` array. Conversations on different surfaces interleaved silently. Per-channel partitioning eliminates that.
- **Context-window blow-up in long sessions.** Without compaction, every turn shipped the full transcript through the model; turn 100 cost ~50× turn 1 in input tokens, and the brain risked HTTP errors near the model cap. Compaction holds prompt size below 50% of contextWindow indefinitely while preserving recent turns verbatim.

### Tests

- Workspace 854 → 938 unit tests (+84). Lint + typecheck clean. Forge tests sanity-check (no contract changes).

## [0.19.19] - 2026-05-05

### Fixed

- **TG approval modal now visually resolves after click.** v0.19.18 fixed callback_query routing so the click reached the runtime resolver, but the message itself stayed in TG with all four buttons because `listener.handleCallbackQuery` only called `answerCallbackQuery` (popup ack), never `editMessageText`. Operators saw a phantom "modal that should be done." Listener now edits the message body to append a resolution suffix (`✅ Allowed once (by 12345)`, `❌ Denied (by 12345)`, etc.) and removes the inline keyboard. Falls back to `editMessageReplyMarkup` (keyboard-only removal) when the original text isn't available. Best-effort: the underlying approval is already resolved at the runtime level, so any edit failure is swallowed.

### Added

- `formatApprovalResolution(choice, byUserId)` exported from `@s0nderlabs/anima-plugin-telegram` — single source of truth for the post-click suffix.
- `approval-resolution.test.ts` (2 cases) pinning the suffix wording for each `ApprovalChoice`.

### Tests

- Workspace 862 → 864 unit tests (+2). lint + typecheck clean.

## [0.19.18] - 2026-05-05

### Fixed

- **Telegram inline-keyboard approval clicks now reach the bot.** `bot.start({ allowed_updates: ['message'] })` filtered every `callback_query` update out of long-poll, so v0.18.1's [Allow Once / Session / Always / Deny] buttons rendered fine but every tap was silently dropped before grammY ever saw it. The brain stayed blocked on the pending approval until timeout; operators saw the modal "do nothing." v0.19.10 fixed handler registration but not the polling spec. Latent since v0.18.0; reproduced live on enigma May 5 2026 when four operator clicks accomplished nothing. Fix: extracted `TELEGRAM_ALLOWED_UPDATES = ['message', 'callback_query']` and added a regression test pinning both kinds.
- **`anima resume` no longer strips the Telegram listener.** Pause then resume cycles silently dropped the bot, the gateway daemon came back up with `plugins: ['telegram']` but no token, and `build-runtime.ts` skipped listener registration. `runResume` now mirrors the v0.18.2 `anima upgrade` pattern: load operator-encrypted secrets via `loadTelegramSecrets`, decrypt with the operator wallet, ECIES-re-encrypt to the harness bootstrap pubkey, ship via the secondary provision envelope. Same identity preserved, listener restored. Added `telegramSecrets?` to `ResumeArchivedSandboxOpts`.
- **Brain stops shelling out for `which chromium ...` before browser tools.** The previous BROWSER_GUIDANCE didn't explicitly forbid environment probes, so the brain interpreted "use the browser tool" as "first verify chromium exists." That triggered a `shell.run` approval prompt and (with the v0.19.18 callback fix unverified at the time) clicks-that-do-nothing led the brain to hallucinate a fallback to `web.fetch` saying "browser tools aren't available in this sandbox." Tightened guidance: `browser.*` is self-contained, registration === availability, no probes.

### Changed

- `TELEGRAM_ALLOWED_UPDATES` exported from `@s0nderlabs/anima-plugin-telegram` so downstream code paths and regression tests reference one source of truth.
- `ResumeArchivedSandboxOpts.telegramSecrets` is the new optional field; `runResume` populates it via the existing `loadTelegramSecrets` helper.

### Tests

- New `listener-allowed-updates.test.ts` (2 cases) pins both `'message'` and `'callback_query'` in the polling spec.
- New `ResumeArchivedSandboxOpts shape` group in `sandbox-provision.test.ts` (1 case) compile-time-asserts the field stays on the public interface.
- New `default system prompt forbids pre-flight environment probes for browser` (1 case) pins the guidance language so a future copy-edit can't quietly re-introduce the hallucination path.
- Workspace 862 unit tests pass (was 854).

## [0.19.17] - 2026-05-05

### Fixed

- **`anima upgrade` browser-deps step failed with `bunx: command not found` on Daytona sandbox.** v0.19.16 invoked `bunx agent-browser doctor` / `bunx agent-browser install --with-deps`, but Daytona's `curl bun.sh/install | bash` install path doesn't always ship a `bunx` symlink. The 3-attempt retry exhausted and `browser-install-failed` propagated to the user. Caught on the v0.19.16 enigma canary. Hotfix: invoke `node_modules/.bin/agent-browser` directly (uses `#!/usr/bin/env node` shebang; Daytona's `daytonaio/sandbox:0.5.0-slim` already provides Node v22.14.0, no bun runtime needed for the install probe). Same wrapper bash pattern, same retry, same exit codes; only the binary path changed.

### Internal

- Updated bootstrap.ts + upgrade-script.ts + 2 tests to assert the new invocation. Workspace 858 unit tests still green.

## [0.19.16] - 2026-05-05

### Fixed

- **Browser tools work inside 0G Sandbox containers.** The `agent-browser` CLI was previously brew-only on macOS, gated off in Linux Daytona containers via an `IS_CONTAINER` short-circuit. v0.19.16 adds `agent-browser` as a workspace npm dependency (`^0.26.0`, vercel-labs/agent-browser, same tool as the brew formula) and runs `bunx agent-browser install --with-deps` during container bootstrap so headless Chrome-for-Testing is provisioned alongside the harness. The container short-circuit is gone; `isBrowserAvailable()` now returns true wherever the binary resolves. Mac host + Linux container share one code path. The first sandbox brain turn that asks "open hacker news" now actually drives a browser instead of returning "host-only" honesty.

### Changed

- **`findAgentBrowser` resolution order: `node_modules/.bin` first, PATH walk second, brew/system dirs third.** Mac users who had a brew install ahead of the npm dep get the npm-pinned version after `bun install` (matches the workspace's lock). Path walk preserved for legacy installs.
- **Bootstrap apt list drops standalone `chromium`.** Playwright's `--with-deps` install pulls in its own Chrome-for-Testing build + the libwoff/libnss system libs Chromium needs. Saves ~80MB of unused apt chromium in the sandbox snapshot.
- **`findAgentBrowser` accepts an optional `cwdOverride` test hook.** Production callers unchanged. Lets the new browser.test.ts assert the node_modules-first priority via a temp-dir stub without monkey-patching `process.cwd`.

### Added

- `agent-browser` ^0.26.0 dependency at workspace root + `packages/plugin-system/package.json` (declarative ownership; bun hoist puts the binary at the workspace `node_modules/.bin/`).
- `bunx agent-browser doctor` idempotency probe in both `bootstrap.ts` and `upgrade-script.ts`. Skip the install step on subsequent upgrades when Chrome-for-Testing is already provisioned.
- `BOOTSTRAP_FAIL_KEYWORDS` and `UPGRADE_FAIL_KEYWORDS` get a new `'browser-install-failed'` entry so the deploy/upgrade poll loops surface install failures distinctly from generic apt or bun failures.

### Internal

- 4 new browser test cells (node_modules-first priority, container-env-no-longer-gates, two re-grouped existing tests). Bootstrap + upgrade-script tests get new "browser deps step is doctor-guarded + ordered after bun install" assertions. Total workspace 858 (up from 854).
- `packages/plugin-system/src/browser.ts` shrinks net ~25 lines: IS_CONTAINER constant deleted, two ternary error branches collapsed into single messages, npx fallback comment removed.
- `packages/plugin-system/src/index.ts` browser registration comment updated to reflect the new install path.

## [0.19.15] - 2026-05-04

### Added

- **Telegram typing indicator.** The bot now shows `typing...` in the chat header for the duration of every brain turn. New `packages/plugin-telegram/src/typing.ts` exposes `startTypingLoop(bot, chatId)` which fires `sendChatAction("typing")` immediately + every 4.5s (TG action expires after ~5s). Wrapped in `try/finally` around the dispatch await in `TelegramListener.dispatchOne` so it stops cleanly on success and error paths. Errors swallowed: a rate-limit on the typing call must never block the actual reply.
- **Telegram tool-call progress streaming (hermes-style).** The brain now surfaces what tool it's running in real time inside TG. New `ProgressTracker` class (`plugin-telegram/src/progress.ts`) sends a "scratch" message with the first tool, then edits it in place as subsequent tools fire. Throttled at 1.5s between edits to coalesce bursts. On TG flood errors (HTTP 429), `canEdit` flips off and remaining lines go as separate messages. Final assistant reply arrives as a separate message (matching hermes pattern). Wires through a new `BrainInferInput.onToolEvent` callback that the brain fires before/after each tool execution; `chat-telegram.ts` (local mode) and `build-runtime.ts` (sandbox mode) both forward the listener's per-turn observer.

### Fixed

- **Browser tool error message + Linux container honesty.** `agent-browser` (Rust binary, brew-only on macOS) is not present in 0G Sandbox Daytona Linux containers, but the previous error message read "agent-browser CLI vanished after resolution (PATH change?). Reinstall with `brew install agent-browser`" — implying a regression where there was none. Two fixes: (1) in containers, the error now reads "agent-browser binary unavailable in this environment. Browser tools are host-only…"; (2) browser.* tools are SKIPPED at registration when running in a Linux container (detected via `DAYTONA_SANDBOX_ID`, `SANDBOX_ID`, or `/.dockerenv` on Linux), so the brain never sees them in its prompt and won't try them. New `isBrowserAvailable()` export on `@s0nderlabs/anima-plugin-system`.
- **Browser path resolution — drop module cache + dangling symlink safety.** `findAgentBrowser` no longer caches the resolved bin path at module load (`binResolved` flag removed). Resolution is microseconds; caching invited the dangling-symlink trap when `brew upgrade agent-browser` ran in another terminal mid-session. Path checks now use `statSync(path, {throwIfNoEntry: false})?.isFile()` (follows symlinks, returns null for broken targets) instead of `existsSync` (which returns true for dangling symlinks). The dead npx fallback (which created spurious `npx agent-browser` cached paths and was never functional since agent-browser isn't on npm) is also gone.
- **Compute ledger insufficient-balance UX.** When the 0G provider returns HTTP 400 because the agent's per-provider sub-account is short, the dispatcher now throws a typed `LedgerInsufficientError` (parsed from the provider message) and the TUI + TG dispatchers surface an actionable message: `Compute ledger sub-account short by X 0G (provider 0x…, locked Y of Z required). Topup with: anima topup compute --amount 2`. Previously the raw provider HTTP 400 body leaked into the UI. Tracks the locked-vs-total distinction explicitly: `ledger.totalBalance` (what the statusline shows) is NOT the same as `getProvidersWithBalance` per-provider locked balance (what the brain actually consumes per request).

### Internal

- 16 new unit tests (5 typing + 7 progress + 4 ledger-error). Total workspace 854 (up from 838).
- Restructure: brain types now expose `BrainToolEvent`, `previewToolArgs`, `inferToolOk` for the per-turn observer.
- `TelegramDispatchInput` extended with optional `onToolEvent` for plumbing through both local and sandbox dispatch paths without touching the runtime context contract.

## [0.19.14] - 2026-05-04

### Fixed

- **TG bot zombie-lock after upgrade — bot stops replying silently.** Root cause caught when elpabl0's enigma stopped responding to two messages on May 4 ~08:15 UTC. The harness shutdown path in `gateway/local-entrypoint.ts` and `gateway/entrypoint.ts` did `Promise.resolve(runtime.stop()).catch(() => {})` (fire-and-forget), then proceeded to `lockHandle.releaseFn()` and `server.close(() => process.exit(0))`. The TG bot-token lock release lives inside `runtime.stop() → dispose() → listener.stop() → releaseLock()`, so on SIGTERM the process exited BEFORE `releaseLock()` ran. The lockfile at `~/.anima/locks/telegram-bot-token-*.lock` persisted with the dying PID. The next harness boot (e.g. via `anima upgrade`) booted within the lock's 5-min TTL, saw `kill(pid, 0)` succeed against the now-zombie or PID-recycled holder, and `acquireScopedLock` returned the existing-holder branch. `TelegramListener.start()` threw `BotTokenLockedError`, the build-runtime `void l.start().catch(...)` swallowed the error, and the listener never tried again. The bot was permanently silent on the new harness. Recovery required manual `rm` of the stale lockfile or container restart.
- Multi-layer fix:
  1. **`gateway/local-entrypoint.ts shutdown()`** is now async and awaits `runtime.stop()` (with the existing 10s force-exit backstop) before releasing the gateway lock and exiting. Plugin listeners now finish their teardown, including `releaseLock()`, before `process.exit(0)`. Single-shot `shuttingDown` guard prevents a second SIGTERM from re-entering.
  2. **`gateway/entrypoint.ts`** (sandbox harness, what enigma runs) gets the same shutdown shape. This was the actual code path that left the v0.19.12-era enigma harness's lock leaked.
  3. **`plugin-telegram/listener.ts`** now retries on `BotTokenLockedError` instead of giving up. Internal `setTimeout` ladder: 12 attempts × 30s = 6 minutes, comfortably past the 5-minute lock TTL so a stale-but-tenable lock auto-evicts. `stop()` cancels the retry timer.
  4. **`core/locks.ts:isStale`** detects zombie processes on Linux. After `process.kill(pid, 0)` succeeds it reads `/proc/<pid>/status` and returns stale=true if `State: Z`. New `isZombieLinux(pid)` helper. Closes Task #277.
  5. **`gateway/upgrade-script.ts`** wipes `$HOME/.anima/locks/*.lock` after killing the prior harness and before relaunching, as insurance against older harness versions whose shutdown didn't release the TG lock cleanly. Without this, the v0.19.13 → v0.19.14 upgrade wouldn't rescue enigma's already-leaked lock.

### Files changed

- `packages/gateway/src/local-entrypoint.ts`: async shutdown, `await runtime.stop()`, single-shot guard, force-exit timer cleared on graceful close.
- `packages/gateway/src/entrypoint.ts`: same shutdown pattern as local mode (sandbox harness).
- `packages/plugin-telegram/src/listener.ts`: retry-on-locked timer ladder, `stopped` guard, retry counter resets on successful acquisition.
- `packages/core/src/locks.ts`: zombie-aware `isStale` on Linux + new exported `isZombieLinux`.
- `packages/gateway/src/upgrade-script.ts`: `rm -f ~/.anima/locks/*.lock` step inserted between `pkill -f anima-gateway` and the relaunch.
- `packages/core/src/locks.test.ts`: zombie-detection smoke + dead-pid eviction tests.
- `packages/gateway/src/upgrade-script.test.ts`: ordering assertion (kill, clear-locks, relaunch).
- `packages/plugin-telegram/src/listener-retry.test.ts` (new, 3 tests): `start()` no-throw on locked, `stop()` cancels pending retry, lockfile released cleanly after retry+stop.

## [0.19.13] - 2026-05-04

### Fixed

- **Brain now knows about anima's deployed singletons + its own pubkey.** Latent harness regression surfaced during the Task #275 enigma TG investigation. When asked "tell me the metadata for the AnimaInbox contract", the brain went `memory.read` (not found) then `shell.run "find /home/daytona/anima -name '*.json' -o -name '*.ts'"` (codebase grep, blocked by approval modal) instead of `chain.contract` against the deployed address. Same defect for "tell me about your A2A presence and pubkey on chain" — no tool returned the agent's pubkey, so the brain composed handwavy text. Root cause: `OnchainRuntimeContext` never carried the singleton addresses (AnimaInbox, AnimaMarket, AnimaAgentNFT) or the agent's own pubkey, so `account.info` couldn't surface them and the brain had no anchor for chain-introspection routing. Fix: extend `OnchainRuntimeContext` with `subname`, `agentPubkey`, `singletons` fields, populate them in `gateway/build-runtime.ts` from `config.subname` + `derivePubkeyHex(agentPrivkey).slice(4)` + `ANIMA_*_ADDRESS[network]`, and surface them in `account.info`'s return data. `ONCHAIN_GUIDANCE` adds a dedicated "Anima singletons" block listing the three CREATE2-deterministic addresses with their roles + the explicit rule "use `chain.contract` on these, NOT `shell.run` to grep, NOT `memory.read`". Ground-truth verified: `cast code 0xcd92844cc0ec6Be0607B330D4BaCC707339f2589 --rpc-url https://evmrpc.0g.ai` returns exactly 560 bytes — matching the brain's earlier reply that was originally suspected as fabrication. The data was always real; the brain just had no reliable way to fetch it.

### Files changed

- `packages/plugin-onchain/src/types.ts`: added `subname?: string | null`, `agentPubkey?: string`, `singletons?: { inbox; market; agentNFT }` to `OnchainRuntimeContext`.
- `packages/plugin-onchain/src/tools/account.ts`: `account.info` return data now includes `subname`, `pubkey`, `singletons` (each defaults to `null` if ctx omits them).
- `packages/plugin-onchain/src/guidance.ts`: rewrote the `account.info` line (reframes it as the canonical identity probe) and added a 4-line "Anima singletons" block hardcoding the three addresses with phase + role descriptions.
- `packages/gateway/src/build-runtime.ts`: imports `ANIMA_AGENT_NFT_ADDRESS` + `derivePubkeyHex` from core, populates the three new context fields when the onchain plugin loads.
- `packages/plugin-onchain/src/tools/account.test.ts` (new): 2 tests covering the populated-ctx path and the omitted-ctx fallback (everything `null`).

## [0.19.12] - 2026-05-04

### Fixed

- **TG MarkdownV2 rendering: brain markdown is now translated, not literally escaped.** Latent rendering bug present since v0.19.0 (and earlier in the v0.18.x train). The listener's `sendChunked` ran `escapeMarkdownV2` on the brain's reply, which blindly backslash-escaped every reserved char including formatting markers. Result: a brain reply like `Your balance: **0.0819 0G**. Wallet ` + "`0xd56b...9683`." + ` arrived in TG as `Your balance: \*\*0\.0819 0G\*\*\. Wallet \`0xd56b\.\.\.9683\`\.` — TG's MarkdownV2 parser treated the escaped backslashes as literal text and the user saw raw asterisks and backticks instead of bold + code formatting. ALL formatting in TG replies on v0.19.0–v0.19.11 was broken in this way. Fix: port hermes' `format_message` algorithm (gateway/platforms/telegram.py:1838-1993) as `formatMarkdownV2(text)`. The translator stashes fenced code blocks, inline code, and `[text](url)` links behind NUL-bracketed placeholders, rewrites `**bold**` → `*bold*`, `*italic*` → `_italic_`, `# heading` → bold, `~~strike~~` → `~strike~`, preserves `||spoiler||` and `> blockquote`, escapes remaining MarkdownV2 reserved chars in plain text, restores placeholders, then runs a safety pass for stray `( ) { }` (preserving link parens). `escapeMarkdownV2` and `stripMarkdownV2` remain available; only `sendChunked` switched.

### Files changed

- `packages/plugin-telegram/src/markdown.ts` (+108 lines): `formatMarkdownV2(content)` translator + private `escapeStrayParens` / `isInsideLinkUrl` helpers.
- `packages/plugin-telegram/src/listener.ts`: `escapeMarkdownV2` → `formatMarkdownV2` import + the single sendChunked call site.
- `packages/plugin-telegram/src/index.ts`: export `formatMarkdownV2` for downstream callers.
- `packages/plugin-telegram/src/markdown.test.ts`: 16 new unit tests (32 markdown-suite total) covering plain text, **bold**, _italic_, headers, inline code, fenced code (with + without lang hint), backslash inside code, links, ~~strike~~, ||spoiler||, blockquote, stray paren escaping, link-paren preservation, real brain reply with mixed formatting.

## [0.19.11] - 2026-05-04

### Fixed

- **`anima upgrade` now threads `config.plugins` into the harness handoff.** P0 hackathon-blocking bug discovered during the enigma sandbox TG canary on v0.19.10. Without this fix, `runInPlaceUpgrade` and `runReprovisionUpgrade` called `handoffAgentToGateway` / `runSandboxProvision` without `plugins`, so the harness fell back to the `['system','comms','onchain']` default in `sandbox-provision.ts`. Operators who ran `anima telegram setup` followed by `anima upgrade` got a sandbox that had `telegram-secrets` provisioned (visible as `(with telegram secrets)` in the provisioned log) but the plugin loader never received `'telegram'` so the listener never started. The bot consumed the polling queue (visible via `getUpdates`) but `[telegram] listener.start() called` never logged. Fix: thread `plugins?: AnimaPlugin[]` through `InPlaceUpgradeArgs` → `handoffAgentToGateway`, plus matching `plugins: args.config.plugins` on the `runSandboxProvision` (reprovision) path. Live verified: re-running `anima upgrade v0.19.10` from the patched local CLI on enigma surfaced both `[telegram] listener.start() called for @enigma` and `[telegram] listener active @anima_enigma_bot` logs, then a real "what time is it on this machine" DM via `web.telegram.org/k/#@anima_enigma_bot` routed cleanly through the brain → `shell.run` inline-keyboard approval rendered in the chat.

### Files changed

- `packages/cli/src/commands/upgrade.ts` (+11 lines): `AnimaPlugin` type import, `plugins?: AnimaPlugin[]` field on `InPlaceUpgradeArgs` with explanatory comment, three call-site additions wiring `config.plugins` → `args.plugins` → `handoffAgentToGateway` / `runSandboxProvision`.

## [0.19.10] - 2026-05-04

### Fixed (telegram dispatch was broken in v0.19.0–v0.19.9; every TG message returned "sorry, something went wrong")

- **Pre-register `bot.on('callback_query:data', ...)` at construction time.** The Phase 14 gateway daemon wired the approval callback handler lazily inside `ensureApprovalCallback()`, which fires per-dispatch from inside grammY middleware. grammY rejects late `bot.on()` calls once polling has started ("registering more listeners from within other listeners"), so EVERY incoming TG message threw at the first dispatch. The throw was swallowed by `dispatchOne`'s catch, the bot replied "sorry, something went wrong on my side. try again in a moment.", and the brain never ran. Fixed by moving the handler to `TelegramListener`'s constructor and reading the resolver from a private slot. `installCallbackHandler` is now just a slot-setter (returns a no-op uninstaller for back-compat). P0 production bug; surfaced during the v0.19.10 B6 matrix run on specter.
- **TG dispatch fires `sync.flushTurn()` fire-and-forget.** Same shape as the v0.19.5 fix for `/chat` HTTP, never applied to the TG path. 0G mainnet finality can take 5+ minutes per write. The previous `await sync.flushTurn()` blocked the per-chatId dispatch serialization lock, so any subsequent TG message queued in inflight for the entire flush window. Live observed: second prompt sat unprocessed for 7+ minutes while first turn's storage flush retried "Log entry is available, but not finalized yet" 328 times. Now: `void sync.flushTurn().then(...)` runs in background and emits a `sync-flush` listener-event so observability is preserved without blocking the reply.
- **Dispatch failures log unconditionally via `console.error` with stack.** The previous `this.log` was debug-only (defaulted off), so the daemon stderr was silent on every dispatch error. Now production daemon logs the full stack of any caught dispatch failure. P2.

### Added

- **`ANIMA_TG_YOLO=1` env var** bypasses the inline-keyboard approval prompter on the TG path. Used by automated test matrices and trusted-operator scenarios where the keyboard click roundtrip is unwanted. Defaults off; production approval flow unchanged.

### Live verification — TG-via-browser tool matrix on specter (mainnet, v0.19.10)

Drove `web.telegram.org/a/#@anima_specter_bot` via agent-browser semantic locators (`#editable-message-text` focus + `keyboard inserttext` + Enter), verified each turn against `~/var/folders/.../tmp/anima-gateway/<id>/activity.jsonl` `tool-call` entries.

**46 tools/flows verified end-to-end:**

- shell.run (date, uname -r, pwd) PASS
- memory.save + memory.read (dark-mode preference round-trip) PASS
- fs.read, fs.write, fs.patch PASS; fs.search HALLUCINATED (brain prefers shell.run+grep)
- shell.process_start / list / kill PASS; shell.process_read soft-fail (brain answered without calling)
- shell.cd, code.execute (python fibonacci) PASS
- skills.list / view / manage, todo, clarify, tool.search, session.search PASS
- delegate.task HALLUCINATED (brain inlined fs.read+todo instead)
- web.fetch PASS (https://example.com → "Example Domain"); vision.analyze plumbing OK (file-missing graceful)
- browser.navigate + snapshot + scroll PASS (live HN top stories); browser.click + back HALLUCINATED (brain context drift, claimed tools missing despite using them earlier in same session)
- chain.balance, tokens.info, swap.quote, chain.gas, chain.block, chain.read, chain.activity, stake.position PASS
- chain.tx graceful (invalid hash); chain.wrap neutral (hypothetical prompt)
- account.info HALLUCINATED (brain prefers memory.read("identity"))
- chain.contract HALLUCINATED (brain prefers fs.search through repo)
- agent.contacts + history PASS; agent.presence HALLUCINATED (brain prefers account.info)
- market.list_my_jobs PASS

7 brain-routing hallucinations are tracked separately as harness regressions for follow-up; harness layer (this fix) is what unblocks the path entirely. Without v0.19.10 not a single tool would have run via TG.

### Files changed

- `packages/plugin-telegram/src/listener.ts` (+50 -38): handleCallbackQuery extracted to construction-time middleware; installCallbackHandler simplified to a slot-setter; dispatch error logged via console.error with stack.
- `packages/gateway/src/build-runtime.ts` (+30 -8): ANIMA_TG_YOLO env-var bypass; sync.flushTurn fire-and-forget with listener-event emit.
- 8 package.json bumps 0.19.9 → 0.19.10. `bun.lock` refreshed.

## [0.19.9] - 2026-05-04

### Fixed (telegram pairing greeting now uses .0g subname)

- **Pairing message addresses the agent by registered name, not hex slug.** Reading `~/.hermes/hermes-agent/{hermes_cli/setup.py:1720, gateway.py:1939}` confirmed hermes ports the same 8-char pairing primitive but threads the bot's friendly identity through. Anima previously hardcoded `agent-${agentId.slice(0, 8)}` in `packages/gateway/src/build-runtime.ts:413`, leaking a debug placeholder into a user-facing surface (`Hi! I'm agent-647702fe and I don't recognize you yet.`). The .0g subname is captured during `anima init` and rendered into `anima.config.ts` via `writeConfigTs(..., { subname })` but never threaded into the gateway's `RuntimeConfig`. Fixed by adding `subname?: string | null` to `RuntimeConfig`, plumbing it through `local-entrypoint.ts` (local mode) + `sandbox-provision.ts` provision envelope (sandbox mode) + every caller (`init.ts`, `deploy.ts`, `upgrade.ts`, `resume.ts`). New `resolveAgentName(subname, agentId)` helper trims whitespace and falls back cleanly. Greeting now reads `Hi! I'm specter and I don't recognize you yet.` Verified live on the running gateway daemon: `[telegram] listener.start() called for @specter`.

### Changed (`anima telegram setup` UX, hermes-aligned)

- **3-mode auth picker, hint @userinfobot.** Previously `anima telegram setup` walked operator from token entry directly to "Allowed Telegram user IDs (comma-separated; blank = pairing-only mode)" prompt. Hermes's `_setup_telegram` (`hermes_cli/setup.py:1720`) and gateway-setup auth-block (`hermes_cli/gateway.py:1939`) both surface a 3-way choice instead. Anima now mirrors hermes: post-token, the wizard asks "How should unauthorized DMs to the bot be handled?" via clack `select` with explicit Pair / Allowlist options. Allowlist branch validates inputs, echoes them back via `note`, hints `@userinfobot` for finding numeric IDs. Pair branch confirms default-deny + the `anima pairing approve telegram <CODE>` workflow. Same encrypt-and-save plumbing underneath; only the prompt sequence is hermes-shaped. Helper extracted to `packages/cli/src/commands/init/telegram-step.ts` so the same logic powers `anima telegram setup` AND the new init Phase E (below).

### Added (Telegram bot setup folded into `anima init` Phase E)

- **Single-command path: agent + bot live after `anima init` finishes.** Hermes folds messaging-platform setup into `hermes gateway setup` Section 4. Anima now mirrors that: post-Phase-D summary (after iNFT mint + subname registration + ledger funding + sandbox provision), the wizard asks "Configure a Telegram bot for this agent now? (recommended)" via `confirm`. If yes, `runTelegramStep` runs inline using the still-unlocked operator wallet (no second Touch ID prompt), reusing the same primitives standalone setup uses. Result is appended to the summary block as `bot @<username> (mode: pair|allowlist)`. Failures are non-fatal: identity / iNFT / subname state is preserved and the operator can re-run `anima telegram setup` later. Operator close happens after the optional TG branch regardless.

### Internal

- New `packages/gateway/src/build-runtime.ts:resolveAgentName(subname, agentId)` pure helper, exported for testability. Six unit tests cover the precedence (subname → trim → fallback) in `packages/gateway/src/build-runtime.test.ts`.
- New `packages/cli/src/commands/init/telegram-step.ts` extracted from the old `telegram-setup.ts` body. `runTelegramStep({ signer, agentId, agentAddress, configPath, config, network })` is content-only; caller (init or telegram-setup) owns intro/outro framing.
- 808 unit tests pass (up from 803). Lint + typecheck clean.

### What does NOT change

- Pairing primitive itself: 8 chars, 1h TTL, 600s rate limit, 3 max pending, alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no I/L/O/0/1).
- Allowlist precedence: allowlist → paired → default-deny. Open-access mode (hermes's `GATEWAY_ALLOW_ALL_USERS`) intentionally not added; default-deny is the locked posture for the hackathon demo path.
- Sandbox-mode Telegram handoff in `chat.tsx` provision envelope unchanged except for the additive `subname` field. Old gateways missing the field fall back to `agent-${slice}` as before.

## [0.19.8] - 2026-05-03

### Fixed (pairing dir mismatch between gateway daemon and CLI)

- **Gateway PairingStore now writes to the same dir the CLI reads from.** v0.19.7 wired the store but used `${agentDir}/pairing` where `agentDir` was the gateway runtime's tmp scratch dir (`tmpdir()/anima-gateway/<id>`). The `anima pairing approve` CLI reads from `~/.anima/agents/<id>/pairing/`. Codes generated by the daemon never reached the CLI's pending list. Fixed by using `agentPaths.agent(agentId).pairingDir` directly, matching the CLI canonical path.

### Live-verified end-to-end

Reset specter's `allowedUserIds=[]`, restarted gateway with v0.19.8 code, sent fresh DM to `@anima_specter_bot`. Bot replied with hermes-spec'd pairing message:
```
🔐 Hi! I'm agent-647702fe and I don't recognize you yet.
Your pairing code: ZNJU9DNS
Send this code to the bot owner and ask them to approve you. They will run:
  anima pairing approve telegram ZNJU9DNS
Codes expire in 1 hour.
```

After fix, CLI sees the pending code and `anima pairing approve telegram <code>` succeeds. User's userId is added to approved set, future DMs reach the brain.

## [0.19.7] - 2026-05-03

### Added (pairing store wired into gateway telegram listener)

- **Gateway now constructs a `PairingStore` for the telegram listener.** When the listener was wired in v0.19.6, the listener context was missing `pairingStore` so unknown senders were silently dropped. Now `build-runtime.ts` instantiates `PairingStore({ dir: <agentDir>/pairing })` and passes it through `TelegramRuntimeContext.pairingStore`. Same directory the `anima pairing` CLI commands read from (`agentPaths.agent(id).pairingDir`), so codes generated by the listener are immediately approvable via `anima pairing approve telegram <code>`.

### Effect on TG onboarding

Hermes-aligned flow now works end-to-end on local mode:
1. Unknown user DMs the bot
2. Listener generates an 8-char code (alphabet excludes 0/O/1/I, 1h TTL, 10min rate limit) and replies via DM
3. Operator runs `anima pairing approve telegram <code>` from any machine with the agent's data dir
4. User's userId is added to the approved set, future DMs go straight to the brain

No more manual `allowedUserIds` editing in the wizard. New users self-onboard via the bot.

### Internal

- 802 unit tests pass.
- Sandbox path also gets the same pairingStore (build-runtime is shared between local and sandbox transports).

## [0.19.6] - 2026-05-03

### Added (B5: telegram listener unified in local gateway)

- **`anima gateway run` now loads telegram secrets in local mode.** Reads `~/.anima/agents/<id>/telegram-secrets.encrypted`, decrypts via the cached telegram scope key from the operator session (no Touch ID), passes the parsed bot token + allowedUserIds to `runtime.start({ secrets })`. The build-runtime path that constructs `TelegramRuntimeContext` now activates in both transports (sandbox and local). Verified live: gateway daemon foreground stdout shows `[telegram] listener active @anima_specter_bot` for the specter agent.

### Walk-away guarantee on the laptop

This was the missing piece for the "close the TUI, agent still replies" story in local mode. Sandbox mode had this since v0.18.2 (B6 of phase 12); local mode only gets it now. After `anima gateway start`, the daemon polls Telegram independently of the TUI lifecycle. Closing the TUI does not stop telegram polling.

### Notes for operators

- A v0.18.0 default-deny policy still applies: `allowedUserIds` must be set via `anima telegram setup` to receive messages. Empty allowlist + no pairing store = listener drops every inbound message (visible as `[telegram] no allowlist configured AND no pairing store. All inbound messages will be DROPPED.` on stdout). Pairing store wiring in the gateway is deferred to a future ship; today the path is to populate `allowedUserIds` directly through the setup command.
- The TUI thin-client (v0.19.4) and chat HTTP fix (v0.19.5) are unchanged. Sending a TG message that hits the allowlist now correctly wakes the brain through the gateway daemon and the SSE `listener-event:telegram-inbound` row appears in any open TUI.

### Internal

- New `loadLocalTelegramSecrets` helper in `packages/gateway/src/local-entrypoint.ts`. Inlines the AES-256-GCM decrypt path with `precomputedKey` so the daemon never needs to invoke a signer.
- `decryptOperatorBlob` already had `precomputedKey` (since v0.19.0); reused as-is.
- 802 unit tests pass. Typecheck + lint clean.

## [0.19.5] - 2026-05-03

### Fixed (TUI regression: chat HTTP timeout)

- **`/chat` HTTP no longer blocks on per-turn memory sync.** v0.19.4 wired the local TUI through the gateway daemon over a unix socket, but the gateway's `runChatTurn` synchronously awaited `sync.flushTurn()` before returning. Chain anchor on 0G mainnet takes 30-60s, longer than Bun fetch's idle timeout, so the TUI showed `chat failed: The operation timed out` even though the brain had already replied. Same pattern that worked for the listener (a2a/market) drains is now used for the stdin path: brain.infer awaited inline, sync.flushTurn fire-and-forget, sync result emitted via SSE `sync-flush` event (TUI already renders that as `synced ... → tx ...`).
- Coalesced overlapping flushes via `#pendingFlush`. `flushSync` (manual `/sync`) and `stop()` await any in-flight background flush before continuing, so explicit syncs still see a complete view.

### Why this matters

Before this fix, the local TUI looked broken even though the gateway was healthy: brain prose appeared in the activity log, tool indicators appeared via SSE, but the TUI rendered the timeout error and the user thought the agent had hung. After the fix, the chat round-trip is decoupled from the chain anchor: the user sees the brain reply immediately, then a `synced ... → tx 0x...` row some time later when the anchor lands. Same UX guarantees as the sandbox path, no protocol changes.

### Internal

- `runChatTurn` no longer returns `syncTx`; the TUI listens for the SSE event instead. `ChatTurnResult.syncTx` is removed (was the only client of it; the telegram dispatch path uses its own sync flow that is independent).
- 802 unit tests pass. Typecheck + lint clean. 124 forge tests pass. Live verified on specter (mainnet iNFT #4) via window 4 TUI thin-client over the gateway daemon: `what time is it on this machine` → `shell.run(date)` → `Sun May 3 21:23:57 WIB 2026` (no timeout); `what is 2 plus 2` → `code.execute(2+2)` + `code.execute(print(2+2))` → `2 + 2 = 4` (no timeout).

## [0.19.4] - 2026-05-03

### Added (B4 complete — TUI auto-detects local gateway)

- **`anima` (TUI) auto-routes to local gateway daemon** when one is running. `chat.tsx` checks for `~/.anima/agents/<id>/gateway.sock` before falling through to the in-process path: if the socket exists, it calls `runChatSandbox` with `unixSocketPath`. Same code path the sandbox mode uses, just over a unix socket instead of TCP. The TUI no longer holds the runtime — the gateway daemon does.
- **`runChatSandbox` accepts `RunChatSandboxOpts.unixSocketPath`**. When set:
  - `SandboxClient` is constructed with the same `unixSocketPath` (the v0.19.3 transport)
  - The Daytona-specific `resumeArchivedSandbox` recovery path is skipped (no Daytona to resume in local mode); on connection failure the user is told to run `anima gateway start` and the process exits cleanly
  - Spinner labels switch from "harness" to "gateway" so the user knows which transport is active

### What this enables

After `anima gateway start`, `anima` (TUI) is a thin client over the local socket. Closing the TUI does NOT stop the listeners (telegram, A2A inbox, market). The agent keeps replying via the gateway daemon. Hermes-aligned architecture: gateway is always-on, TUI is transient. The "walk away from laptop, agent keeps replying" promise now holds in local mode, not just sandbox mode.

### Internal

- 802 unit tests pass (re-verified post-bump per /seal Step 4d). Typecheck + lint clean. 124 forge tests pass.
- chat.tsx footprint: +13 lines for the auto-detect block; chat-sandbox.tsx footprint: +25 lines for the `RunChatSandboxOpts` opt-in path. The bulk of the runtime stays unchanged — same SSE/HTTP/approval round-trip semantics.
- Live test deferred to v0.19.5 alongside the rigorous tool-by-tool tmux drive (B6).

## [0.19.3] - 2026-05-03

### Added (B4 partial — unix socket transport, live-verified)

- **`SandboxClient` accepts `unixSocketPath`** option. When set, every fetch routes via Bun's `fetch(url, {unix: '/path'})` instead of TCP. Endpoint URL host is ignored (kernel routes via socket); convention is `http://localhost`. Lets the CLI talk to a local gateway daemon over `~/.anima/agents/<id>/gateway.sock`.
- **`test/local/e2e-gateway-local-socket.ts`** — live integration test. With `anima gateway start` running, calls `client.health()` over unix socket and verifies state=Ready + agentAddress matches config. Passed live against PID 86783 daemon (state=Ready, version=0.19.2, agent=0x1e93…C99f).

### Live-verified (everything from v0.19.0 onwards)

This ship's testing was rigorous, not assumed. With the gateway daemon spawned for specter agent (mainnet iNFT #4):

- ✅ `anima gateway status` (no gateway): correct "absent" reporting
- ✅ `anima gateway start`: derives operator session via keychain (no Touch ID with always-allow), pre-derives keystore + telegram scope keys via `precomputeAllScopes`, writes `.operator-session` perm 0600 with 24h TTL, forks daemon detached, restores 4 memory slots from 0G Storage, reaches `runtime ready agent=0x1e93…C99f`, binds unix socket
- ✅ `anima gateway status` (running): shows PID 84475 alive, lock-age 32s, session fresh 23h59m remaining, scopes [keystore, anima-telegram-v1]
- ✅ `anima gateway stop`: SIGTERM → daemon exits cleanly, socket unlinked, lock unlinked
- ✅ `anima gateway start` after stop (cached session): NO Touch ID prompt, daemon up at new PID 86783 in ~1s, socket bound immediately
- ✅ Identity preserved across stop/restart (same agent EOA `0x1e93…C99f`)
- ✅ Memory slots auto-restored from 0G Storage on each boot
- ✅ Unix socket /healthz handshake from independent process via SandboxClient

### Internal

- 802 unit tests pass (re-verified post-bump per /seal Step 4d). Typecheck + lint clean. 124 forge tests pass.
- v0.19.x cumulative file scorecard: 14 new files (operator-session.{ts,test.ts}, local-entrypoint.ts, anima-gateway-local bin, gateway.ts dispatcher, 6 gateway-{run,start,stop,restart,status,logs}.ts, e2e-gateway-local-socket.ts) + 30+ rename touch-points + 4 server.ts/operator-keystore-crypto.ts modifications.
- Phase 14 next (v0.19.4+): wire chat.tsx auto-detection so `anima` (TUI) routes to the local gateway daemon via socket when one is running. Today the unix socket transport works, but chat.tsx still embeds its own runtime by default.

## [0.19.2] - 2026-05-03

### Added

- **`anima gateway <sub>` CLI surface** (B3). Run/start/stop/restart/status/logs subcommands wired through `packages/cli/src/commands/gateway.ts` argv dispatcher.
  - `anima gateway run` — foreground daemon (blocks; Ctrl+C to stop). Spawns `anima-gateway-local` from `@s0nderlabs/anima-gateway/bin/` with stdio inherit. Resolves the bin path via `import.meta.resolve` so it works in both workspace dev mode and installed npm node_modules.
  - `anima gateway start` — interactive flow: loads operator signer (Touch ID), pre-derives keystore + telegram scope keys via `precomputeAllScopes`, writes `~/.anima/agents/<id>/.operator-session` (perm 0600, 24h TTL), forks the gateway daemon detached, waits up to 10s for the unix socket to appear (proves the daemon booted cleanly).
  - `anima gateway stop` — reads PID from `~/.anima/locks/anima-gateway-<hash>.lock`, sends SIGTERM, falls through to SIGKILL after 5s grace. Cleans up stale lock + socket files.
  - `anima gateway restart` — stop then start.
  - `anima gateway status` — reports PID + alive/dead + lock age + socket presence + operator-session freshness + scope keys. Sub-second; no network.
  - `anima gateway logs [--tail N] [-f]` — tail stub (file logging is v0.19.3; today this prints the daemon stdout location for `anima gateway run`).
- **NEW `packages/gateway/bin/anima-gateway-local`** — bin entry that imports `local-entrypoint.ts`. Added to `packages/gateway/package.json` `bin` map alongside the existing `anima-gateway` (sandbox entry).
- **`anima` argv dispatch** wires `case 'gateway':` in `packages/cli/src/index.ts`. `printHelp()` shows the new command in the `anima help` output.

### Changed

- v0.19.0 / v0.19.1 ship retrospective captured in commit + memory: 5 distinct CI failure modes across the rename. The `/seal` skill hardening from v0.19.1 (Step 4d re-verify, Step 7a HEAD-version-vs-tag, Step 7c CI watch) was exercised in this ship — version bump used surgical sed (preserves biome single-line array format) and the post-bump lint+typecheck+test re-run caught zero regressions.

### Internal

- 802 unit tests pass. Typecheck + lint clean (re-verified post-bump per Step 4d). 124 forge tests pass.
- Local-entrypoint not yet end-to-end tested against a live agent — runtime adapter integration needs the chat.tsx thin-client refactor (B4 / v0.19.3) to give `anima` (TUI) a way to talk to the daemon over the unix socket. Today the gateway boots and binds the socket; the TUI still embeds its own runtime. Nothing user-visible changes in v0.19.2 — but the foundation for the daemon split is fully in tree.
- npm publish: 7 packages × v0.19.2 (telegram + gateway both included via the v0.19.1 release.yml fix).

## [0.19.1] - 2026-05-03

### Fixed

- **CI release pipeline: `@s0nderlabs/anima-plugin-telegram` was never added to `.github/workflows/release.yml`** (regression introduced in v0.18.0 when the plugin landed). Added the missing publish step between gateway and cli per the dependency order. v0.19.0 partially published 4 of 7 packages because (a) the lint check passed locally but failed on CI for biome multi-line array format, then (b) the publish step for gateway used the now-stale `packages/harness/` path. v0.19.1 ships all 7 packages cleanly.
- **`/seal` skill hardened**: new Step 4d re-runs lint + typecheck after the version bump (catches the JSON.stringify multi-line-array trap that hit v0.17.6, v0.18.2, v0.18.3, v0.19.0). New Step 7a verifies HEAD's package.json version matches the tag name before pushing. New Step 7c watches CI for early failures via `gh run list`. Step 4c now recommends surgical sed-based version bumps (preserves formatting) over `JSON.stringify(p, null, 2)` (reformats).

### Added (B1 partial — not yet user-facing)

- **NEW `packages/gateway/src/local-entrypoint.ts`** (~230 LOC): Local-mode gateway entrypoint that boots without the Daytona ECIES handshake. Reads operator-session for cached AES keys, decrypts agent keystore from `~/.anima/agents/<id>/keystore.json`, builds session + RealRuntime + provisions inline (no HTTP /bootstrap/provision wait), binds unix socket at `~/.anima/agents/<id>/gateway.sock` with perm 0600, acquires host-wide gateway lock with 60s refresh, sets `trustLocal: true` on the server (file-perm-based auth replaces EIP-191 sigs). Required env: `ANIMA_AGENT_ID` + `ANIMA_CONFIG`. Skips heartbeat (Daytona-only). Graceful shutdown unlinks socket + releases lock. Not yet wired to a CLI command — `anima gateway run`/`start`/etc land in v0.19.2 alongside lifecycle plumbing.

### Internal

- 802 unit tests pass. Typecheck + lint clean. 124 forge tests pass.
- npm registry post-v0.19.0 partial-publish state: anima-core, anima-plugin-comms, anima-plugin-onchain, anima-plugin-system at 0.19.0 (orphans). v0.19.1 republishes all 7 at 0.19.1 so consumers get a coherent set.
- Wake from /loop on CI completion verified the publish-pipeline hardening; failure ledger across 5 distinct modes captured for next /seal post-mortem.

## [0.19.0] - 2026-05-03

### Changed

- **`packages/harness` renamed to `packages/gateway`**. Same code, semantic name. The harness was always a gateway in role: a long-running process that owns the brain runtime, listeners (TG + A2A inbox + market), tool registry, and memory sync. Phase 14 separates this gateway role from the TUI cleanly. v0.19.0 is the foundation rename; v0.19.1 adds the local entrypoint (`anima gateway run`) that runs the same gateway code on a laptop without the Daytona handshake.
- **npm package: `@s0nderlabs/anima-harness` → `@s0nderlabs/anima-gateway`** (workspace dep + npm name). v0.18.x consumers must update imports.
- **Type renames**: `HARNESS_VERSION` → `GATEWAY_VERSION`, `HarnessSession` → `GatewaySession`, `HarnessState` → `GatewayState`, `HarnessEvent`/`HarnessEventKind` → `GatewayEvent`/`GatewayEventKind`, `HarnessSecrets`/`HarnessSecretsSchema` → `GatewaySecrets`/`GatewaySecretsSchema`. Function renames: `createHarnessServer` → `createGatewayServer`, `handoffAgentToHarness` → `handoffAgentToGateway`, `buildHarnessRelaunchScript` → `buildGatewayRelaunchScript`, `probeHarnessAlive` → `probeGatewayAlive`, `relaunchHarnessDaemon` → `relaunchGatewayDaemon`, `parseHarnessSecrets` → `parseGatewaySecrets`.
- **Binary**: `bin/anima-harness` → `bin/anima-gateway`. The `pkill -f anima-gateway` in upgrade-script.ts is augmented with a sibling `pkill -f anima-harness` for backward-compat: v0.18.x → v0.19.0 in-place upgrade kills BOTH the legacy and new daemon on the existing Daytona container.

### Added

- **`packages/core/src/wallet/operator-session.ts`** — per-agent on-disk cache of operator-derived AES-256 keys (one per scope: keystore + telegram + future scopes). File at `~/.anima/agents/<id>/.operator-session` with permission 0600 and 24-hour default TTL. Written via `precomputeAllScopes(signer, agent, [scopes])` after a single Touch ID unlock; read by the headless gateway daemon at boot to bypass interactive operator unlock per restart. Same security model as hermes's `~/.hermes/.env` plaintext API key store. Atomic temp+rename writes with explicit `chmod 0o600` (try/catch wraps for non-POSIX hosts where chmod is advisory). Stale sessions auto-deleted on read. Exports: `writeOperatorSession`, `readOperatorSession`, `clearOperatorSession`, `isOperatorSessionFresh`, `getSessionKey`, `precomputeAllScopes`, `buildOperatorSession`, `OPERATOR_SESSION_VERSION`, `DEFAULT_OPERATOR_SESSION_TTL_MS`. 19 unit tests.
- **Pre-derived key opt on `decryptAgentKey` and `decryptOperatorBlob`**. Both accept optional `precomputedKey: Buffer` (32 bytes) that bypasses `signer.signTypedData`. The pre-derived key is fully equivalent to the on-the-fly derived key (RFC-6979 deterministic ECDSA + HKDF-SHA256), so the security model is preserved. Net effect: the gateway daemon can boot from disk + a session file without prompting Touch ID.
- **`deriveKeystoreKey` and `deriveBlobKey`** are now public exports (used by the operator-session writer to compute the cached keys).

- **`trustLocal` flag on `createGatewayServer`**. When true, `/chat` and `/approval/:id/respond` skip EIP-191 signature verification. Defaults to false (sandbox-mode unchanged). Will be enabled by `anima gateway run` (v0.19.1) when binding a unix socket where file permissions provide equivalent authentication. Today: zero callers pass `trustLocal: true`, so no functional change.

### Internal

- 802 unit tests pass (up from 783; +19 from operator-session.test.ts).
- Typecheck + lint clean.
- 124 forge tests pass (no contract changes).
- bun.lock refreshed to pin all 7 workspace packages at 0.19.0.
- `tsconfig.json` and `packages/cli/tsconfig.json` references updated for the rename.
- The `entrypoint.ts` (sandbox path) is unchanged in behavior; only string-level renames.

## [0.18.3] - 2026-05-04

### Added

- **Mock-bot e2e test** at `test/local/e2e-telegram-mock.ts`. Spins up an in-process HTTP server matching the Telegram Bot API contract (getMe, getUpdates, deleteWebhook, sendMessage, setMessageReaction). 19 assertions cover token lock acquire/block/release, retry classifier (timeout=fail, conn=retry, forbidden=fail-silent), default-deny + pairing flow code generation, bypass command parser, chunking with (1/N) suffix, MarkdownV2 parse-error detector, session-key shape, full listener inbound→dispatch→reply roundtrip, explicit deleteWebhook before polling, delivery-failure notice text. Run via `bun test/local/e2e-telegram-mock.ts`.
- **Operator-driven tmux drive runner** at `test/local/tmux-telegram-drive.ts`. agent-browser cannot reliably drive TG WebK (contenteditable + React controlled-input rejects programmatic typing — documented from May 3 session). Runner watches `activity.jsonl` for `wake source=telegram` + `brain-response source=telegram` + tool-call entries while the operator DMs the bot from their TG client. Exits 0 on observation, 1 on 5min timeout.

### Internal

- v0.18.3 closes Phase 12. The `phase-12-shipped.md` memory file documents all 9 bundles, hermes drift closures, file changes, and the demo path. Outstanding items (full 409/network retry loop, daemon split for local mode, photo/document inbound) deferred to v0.19+.
- Test count: 783 unit + 19 mock e2e = 802 total assertions green.
- `@s0nderlabs/anima-plugin-telegram` added as workspace devDep on root `package.json` so `test/local/*.ts` can import from it.

## [0.18.2] - 2026-05-04

### Added

- **Sandbox-mode telegram listener** (closes G3 from the Phase 12 audit). The harness `build-runtime.ts` now constructs a full `TelegramRuntimeContext` when `secrets.telegram` is present after provision: dispatches inbound DMs through `brain.infer({source: 'telegram'})`, publishes `telegram-inbound` / `telegram-outbound` / `telegram-processing-start` / `telegram-processing-end` events to the EventHub so chat-sandbox.tsx renders rows, swaps the permission prompter to the TG-aware bridge for inline-keyboard approval, fires per-turn `sync.flushTurn()`, and threads `TELEGRAM_GUIDANCE` into `extraGuidance`. Before this, the harness's `pluginNames` filter accepted `'telegram'` but the side-band ctx was hollow → the plugin loaded but did nothing.
- **`secretsEnvelope` in provision flow**. New `packages/harness/src/secrets.ts` defines `HarnessSecretsSchema` (zod) covering optional `telegram: { botToken, allowedUserIds, pairingApproved? }`. `ProvisionRequest` extends with optional `secretsEnvelope: ProvisionEnvelope`; `provisionMessageHash` includes a new `bytes32 secretsEnvelopeHash` (zero-hash sentinel when absent) so the operator's signature covers both envelopes — a stolen secrets envelope can't be replayed against another harness. Server `/bootstrap/provision` decrypts both envelopes with the bootstrap privkey and parses the secrets JSON against the zod schema; failures abort provision with a clear error.
- **`anima upgrade` re-handoff with telegram secrets**. When the local `~/.anima/agents/<id>/telegram-secrets.encrypted` blob exists, `runInPlaceUpgrade` decrypts it via the operator wallet's sign-derived key, ECIES-encrypts the plaintext to the bootstrap pubkey, and ships it alongside the agent privkey envelope. v0.18.2+ harnesses pick it up automatically; v0.17.x harnesses ignore the field (legacy hash compat preserved).
- **`chat-sandbox.tsx` telegram event rendering**. New row roles for `telegram-inbound` (TG-blue with `@username` + chat preview), `telegram-outbound` (system row showing chatId + length), and `telegram-processing-{start,end}` (status rows mirroring local-mode TUI hooks).

### Changed

- **`runtime.RuntimeAdapter.start` signature** extends with optional `secrets?: HarnessSecrets`. Both `RealRuntime` and `StubRuntime` accept the new field; the value threads to `buildAnimaRuntime` via the same `opts.secrets` path.
- **`HandoffAgentToHarnessOpts`** in `sandbox-provision.ts` accepts optional `telegramSecrets: { botToken, allowedUserIds, pairingApproved? }`. When present, the helper ECIES-encrypts a JSON blob to the bootstrap pubkey and includes the resulting envelope in the provision request.

### Internal

- New `packages/harness/src/secrets.ts` — `HarnessSecrets` + `parseHarnessSecrets`.
- 8 file modifications: `auth.ts` (extended ProvisionRequest + provisionMessageHash), `server.ts` (decrypt secrets envelope), `runtime.ts` + `real-runtime.ts` (start opts), `build-runtime.ts` (telegram side-band ctx + dispatch + approval bridge wiring), `client.ts` (provision payload), `sandbox-provision.ts` (handoff with telegram secrets), `upgrade.ts` (re-handoff path), `chat-sandbox.tsx` (event rendering).
- Test count unchanged (783); existing harness tests still pass with the additive ProvisionRequest field.
- B7's listener.getStatus polish deferred to v0.19+ (cosmetic only). G5 metadata fix already landed in B1 alongside debounce.ts.

## [0.18.1] - 2026-05-04

### Added

- **Active-session interrupt + bypass commands** in plugin-telegram. New `session-state.ts` exports `ActiveSessionTracker` (synchronous mark-active before async dispatch closes the race per hermes `base.py:1471`) and `BYPASS_COMMANDS = ['/stop', '/new', '/reset', '/status', '/approve', '/deny', '/background', '/restart']` with `parseBypassCommand`. Bypass commands skip the queue + busy gate entirely. `/stop` aborts the active brain turn for the matching sessionKey via the tracker's stored AbortController; `/status` reports thinking/idle. 16 unit tests.
- **Queue drain on stdin idle** in chat.tsx. New `state.onStatusChange(cb)` subscriber fires drain whenever brain returns to idle. Closes G4 starvation: TG messages queued during a stdin turn used to stay stuck until the next inbound; now they drain immediately on stdin completion.
- **MarkdownV2 escape + plain-text fallback** in plugin-telegram (`markdown.ts`). `escapeMarkdownV2` regex `r'([_*[\]()~`>#+\-=|{}.!\\])'` matches hermes `telegram.py:84` verbatim. `stripMarkdownV2` removes escape backslashes + `*bold*`, `_italic_`, `~strike~`, `||spoiler||` markers for the fallback path. `isMarkdownParseError` detects the canonical `can't parse entities` error. 14 unit tests.
- **Long-message chunking with (1/N) (2/N) suffix** in plugin-telegram (`chunking.ts`). `splitMessage(text, {maxLen=4000, numbered=true})` avoids splits inside fenced code blocks, prefers word-boundary splits, and appends raw `(1/N)` suffixes. `escapeChunkSuffixForMarkdownV2` escapes parens for MarkdownV2 mode. 8 unit tests.
- **Inline-keyboard approval** in plugin-telegram (`approval-keyboard.ts`). `buildApprovalKeyboard(approvalId)` returns the 4-button layout (Once / Session / Always / Deny), `parseCallbackData` extracts `{choice, approvalId}` from `ea:<choice>:<approvalId>` strings, `handleApprovalCallback` performs re-validation against `allowedUserIds` (defense-in-depth: anyone can SEE buttons but only allowed users can click) + one-shot pop pattern. `makeApprovalIdFactory` mints monotonic `a-1`, `a-2` ids. 12 unit tests.
- **Telegram permission prompter** in chat-telegram. `runOne` builds a TG-aware `PermissionPrompter` that closes over `input.chatId` and the listener's approval bridge. Generates approvalId, registers a Promise resolver in a shared Map, sends inline keyboard via the bridge, awaits callback (or 5min timeout). Maps `once → allow-once`, `session/always → allow-session`, `deny → deny`. Tool calls in TG turns now route through the phone-side approval flow; the laptop modal is bypassed.
- **Listener approval bridge wiring**. `TelegramRuntimeContext.approvalBridge` exposes mutable slots `sendApproval` + `installCallbackHandler`. Listener fills them on `start()` so the dispatcher (chat-telegram for local mode, harness build-runtime for sandbox mode) can roundtrip approval requests through the bot. Single `bot.on('callback_query:data')` handler validates clicker against `allowedUserIds` and forwards to the dispatcher's resolver Map.

### Changed

- **Listener `sendChunked()` replaces `capForTelegram` truncation**. Long replies now split into multiple messages with `(1/N)` numbering instead of truncating at 4000 chars with `[reply truncated]`. MarkdownV2 escape is applied per chunk; on `parse_error` the listener falls back to `stripMarkdownV2` plain text. On retry exhaustion the listener sends `DELIVERY_FAILURE_NOTICE` once.
- **`runOne` (chat-telegram)** swaps `permission.setMode('off')` (YOLO) only when no approval bridge is wired. With the bridge filled, mode stays `'prompt'` and TG turns route through the phone-side prompter for dangerous patterns / shell-class invocations / value-moving txs.
- **`debounce.test.ts`** + sanitize.test.ts updated for the new metadata-carrying fragment shape (G6 follow-through).

### Internal

- 50 new unit tests bring the project total to 783 (+6.8% from v0.18.0's 733).
- 5 new files: `markdown.ts`, `chunking.ts`, `approval-keyboard.ts`, `session-state.ts` + their `.test.ts` peers (technically 4 new test files).
- 3 file rewrites: `chat-telegram.ts` (prompter swap + bypass routing + queue drain handle), `listener.ts` (chunked sends + bridge wiring + callback-query handler), `state.ts` (`onStatusChange` subscriber).
- B6 (sandbox handoff close G3), B7 (G5 polish), B8 (e2e + tmux drives) ship in v0.18.2 + v0.18.3.

## [0.18.0] - 2026-05-04

### Added

- **Hermes-aligned Telegram gateway foundation**. Phase 12 redesign per `hermes-telegram-deep-research.md`. Closes hermes drifts G1 (no token lock) and G2 (no pairing). Bundles B0+B1+B2+B3 of the v0.18.x series.
- **`acquireScopedLock`** in `@s0nderlabs/anima-core` (`locks.ts`). Host-wide PID-file lock at `~/.anima/locks/<scope>-<sha256(identity).slice(0,16)>.lock`. O_CREAT|O_EXCL atomic create; stale-detection via `process.kill(pid, 0)`; TTL eviction (default 300s) as belt + suspenders. Refresh + release handles. Used by `plugin-telegram` to prevent two anima processes on the same machine from polling the same bot token (a common 409 Conflict source). 12 unit tests.
- **`PairingStore`** in `@s0nderlabs/anima-core` (`pairing.ts`). 1:1 port from hermes `gateway/pairing.py` (288L → ~250 LOC TS). 8-char codes from 32-char unambiguous alphabet (no 0/O, 1/I), 1-hour TTL, max 3 pending per platform, 1 request / user / 10 min rate limit, 5 failed approvals → 1-hour platform lockout. Atomic temp+rename writes with chmod 0600. 18 unit tests including code gen randomness, TTL expiry, rate limit, lockout, approve flow, revoke, multi-platform aggregation, file permissions.
- **`anima pairing` CLI** with subcommands `list`, `approve <platform> <code>`, `revoke <platform> <userId>`, `clear-pending [platform]`. Validates code format (8 chars from alphabet) before invoking the store. Confirmation prompts via clack with `--yes/-y` skip flag. 10 unit tests on argv parsing.
- **Listener resilience layer** in `@s0nderlabs/anima-plugin-telegram` (`recovery.ts`):
  - `acquireTelegramTokenLock(botToken, opts)` — wraps `acquireScopedLock` with the `'telegram-bot-token'` scope; throws `BotTokenLockedError` when another process holds it.
  - `clearWebhookBeforePolling(bot)` — explicit `bot.api.deleteWebhook({drop_pending_updates: false})` before `bot.start`. Belt + suspenders even though grammy does this internally.
  - `classifyStartFailure(err)` — partitions errors into `conflict | network | auth | fatal | cancelled` with `retryable: bool`. Used by listener to log structured start failures.
  - 10 unit tests.
- **DM pairing flow**. When an unknown user DMs the bot AND the plugin has `pairingStore`, sanitize returns `{ok: false, action: 'send-pairing-code', code}`. The listener replies with a 1-hour TTL pairing code via `formatPairingMessage(code, agentName)`. Operator runs `anima pairing approve telegram <code>` to approve. The user's next message reaches the brain.
- **Adaptive text-batch debounce** in `DebounceBuffer`. Default 600ms quiet period; bumps to 2000ms when the last fragment is ≥4000 chars (TG client splitting a long paste into adjacent updates). Mirrors hermes `HERMES_TELEGRAM_TEXT_BATCH_DELAY_SECONDS` + `_SPLIT_DELAY_SECONDS` constants.
- **Retry classifier exports** in `retry.ts`: `RETRYABLE_PATTERNS`, `TIMEOUT_PATTERNS`, `isRetryable`, `isTimeout`, `isReplyNotFound`, `isThreadNotFound`, `DELIVERY_FAILURE_NOTICE`. Patterns ported verbatim from hermes `base.py:709`. Timeouts are explicitly NOT retryable (delivery may have completed; retry = double-send).

### Changed

- **Sanitize default-deny semantics**. `sanitizeInbound` now treats empty `allowedUserIds` as deny-all (matching hermes default-deny model) instead of open-access. The listener emits a loud startup warning when `allowedUserIds` is empty AND no `pairingStore` is provided (`All inbound messages will be DROPPED`). Senders not in the allowlist but with `pairingStore` available go through the pairing flow.
- **Sender metadata carried through debounce**. `BufferedFragment` and `FlushedBatch` now include `userId`, `username`, `displayName`. Closes G6 from the Phase 12 audit (sender metadata was previously dropped at the buffer boundary; `dispatchOne` had `username: null, displayName: null` hardcoded).
- **Wizard copy** in `anima telegram setup` updated to reflect default-deny semantics. Empty allowlist now reads "pairing-only mode" with explicit `anima pairing approve telegram <CODE>` instructions instead of the old "open access — anyone who finds the bot can DM" warning.
- **`agentPaths.agent(id).pairingDir`** added to `@s0nderlabs/anima-core` for per-agent pairing storage at `~/.anima/agents/<id>/pairing/`.

### Internal

- 43 new unit tests bring the project total to 733 (+9.6% on prior 690 baseline).
- 11 new files (`locks.ts`, `pairing.ts`, `recovery.ts`, `pairing-flow.ts`, 4× `pairing-*.ts` CLI handlers, plus argv test) and 2 file rewrites (`sanitize.ts`, `debounce.ts`).
- `bun run lint` clean (biome auto-organized imports, normalized formatting); typecheck clean.
- B4 (active-session interrupt + bypass commands), B5 (phone-side UX: MarkdownV2 + chunking + inline-keyboard approval + permission prompter swap), B6 (sandbox handoff close G3), B7 (G5 metadata polish), B8 (mock e2e + tmux drives + browser-driven live tests) ship in v0.18.1, v0.18.2, v0.18.3 across 3 more /seal cycles.

## [0.17.9] - 2026-05-03

### Fixed

- **`anima upgrade` argv positional-ref parsing**. v0.17.8's positional-ref scan walked the whole argv array and matched `argv[0]` (the literal `'upgrade'` subcommand token) as the ref. Result: `anima upgrade --yes` (and `anima upgrade latest`, `anima upgrade v0.17.8`) all failed mid-flight with `git checkout 'upgrade': pathspec did not match`. Caught immediately during the v0.17.8 enigma canary. Fix: extract `parseUpgradeArgs(tail)` to `commands/upgrade.ts` (operates on `argv.slice(1)`) with 9 unit tests covering every flag/positional combination.

## [0.17.8] - 2026-05-03

### Added

- **`anima upgrade` now resolves to the latest GitHub release by default**. Bare `anima upgrade` queries `api.github.com/repos/s0nderlabs/anima/releases/latest` and uses whatever tag is published. Shortcuts: `anima upgrade latest` (explicit) and `anima upgrade v0.17.8` (positional pin). The old `--ref` flag continues to work; `ANIMA_BOOTSTRAP_REF=main` is the dev escape hatch. Closes the friction of looking up the latest version + retyping it.
- **Pre-flight tag visibility check**. When the user pins an explicit tag, the CLI calls `GET /repos/.../git/refs/tags/<tag>` before invoking the in-container upgrade. A 404 surfaces as a clear `Tag <ref> is not visible on the remote yet (CI may still be propagating). Try again in 30s` cancel, instead of letting the upgrade run and fail mid-fetch.
- **Post-flight version verification**. After the in-container DONE marker, the CLI reads `~/anima/packages/harness/package.json` from the container and asserts `version` matches the resolved tag. On mismatch, the upgrade aborts BEFORE the agent privkey re-handoff with a `silent-success regression: expected X, got Y` message + retry hint. Closes the silent-success bug surfaced 2026-05-03 on enigma where `anima upgrade --ref v0.17.7` reported success but the container stayed at v0.17.5.

### Internal

- New `packages/cli/src/util/github-releases.ts`: `parseGitHubRepoUrl`, `resolveLatestRelease`, `checkTagExists`. AbortSignal-timed (10s default), no auth needed for public repo, `fetchImpl` injection point for tests.
- New `packages/cli/src/util/ref-resolver.ts`: `resolveAnimaRef(rawRef?, opts?)` returns `{ref, isTag, resolvedFromLatest}`. Single source of truth for ref resolution; ready to be reused by `anima init` / `anima deploy --reprovision` in a future ship.
- 19 new unit tests across the two helper modules (mocked fetch, no live API calls).

## [0.17.7] - 2026-05-03

### Added

- **`anima` chat auto-resumes a dead harness**. Previously, running `anima` against a paused or otherwise unreachable harness errored out at `harness not ready` and required manually running `anima resume` first. Now `chat-sandbox.tsx` falls back to the full resume path (probe state, restore from archive if needed, relaunch the harness daemon, re-handoff the agent privkey) and retries `waitReady` automatically. The fast-path `waitReady` is shortened to 8 seconds so healthy harnesses still feel instant.
- **`HARNESS_VERSION` is now derived from the harness package.json** (`import pkg from '../package.json' with { type: 'json' }`). `/healthz` reports the actual deployed version instead of the previously hardcoded `0.15.0`. Closes #202.
- **`release.yml` fail-fast guard**: a new step at the top of the workflow compares `${GITHUB_REF_NAME}` against `v$(node -p "require('./package.json').version")` and exits 1 with a clear `::error::` annotation if they don't match. Catches the "tagged before bumping version" race that previously surfaced as `403 Forbidden: cannot publish over previously published versions` deep in the publish steps. Saves ~90 seconds + a wasted-CI-minute email per offense.

## [0.17.6] - 2026-05-03

### Fixed

- **`anima pause` archive deadline 60s → 5min**. Daytona's archive snapshots the container filesystem to object storage; verified live to take >60s sometimes. `ensureSandboxArchived` now defaults to a 5-minute archive-phase deadline (still 60s for the stop phase). Operators can override via the new `archiveDeadlineMs` / `stopDeadlineMs` opts; the legacy `deadlineMs` opt still works for callers that want symmetric tuning.
- **Harness relaunch script syntax error**. v0.17.4's `buildHarnessRelaunchScript` joined the launch parts with `&&` between every step, including between the `nohup ... &` background-fire and the trailing `echo relaunch-launched`. That produced `& && echo` which bash rejects. Mirrored the upgrade-script.ts / bootstrap.ts pattern: chain file-write commands with `&&`, then use a single space-separated `&` (background) followed by the success-line `echo`.

## [0.17.5] - 2026-05-03

### Fixed

- **`anima resume` now relaunches the harness even when the sandbox was already `started`**. v0.17.4 only triggered the relaunch path when `initialState !== 'started'`. The orphaned-harness recovery scenario (sandbox alive, harness daemon dead) was still broken. The probe now runs unconditionally after `ensureSandboxStarted`; if `/bootstrap/pubkey` doesn't respond the relaunch fires regardless of how the sandbox got into that state.

## [0.17.4] - 2026-05-03

### Fixed

- **`anima resume` now relaunches the harness daemon after Daytona restore**. When Daytona archives a sandbox, the filesystem is preserved but every process inside the container is terminated. Daytona's `/start` brings the container back online but does NOT auto-restart any user daemons. v0.17.1's `resumeArchivedSandbox` only worked on never-archived (already-started) sandboxes; on a real archive→restore path the harness daemon was dead and `/bootstrap/pubkey` timed out at 60s. Caught live during the v0.17.3 canary on enigma.
- New `buildHarnessRelaunchScript` helper in `@s0nderlabs/anima-harness` mirrors the launch portion of `buildBootstrapScript` (env exports + `fuser -k` + 3-attempt `nohup bun anima-harness` retry) without the apt/clone/install steps. Container snapshot is intact, so we just need to relaunch the daemon.
- `resumeArchivedSandbox` now probes `/bootstrap/pubkey` for 8s after `ensureSandboxStarted`. If unresponsive, fires the relaunch script via `provider.execInToolbox` and polls `/bootstrap/pubkey` for up to 60s with `RELAUNCH_FAIL_MARKER` short-circuit on failure. Idempotent: if the harness IS responding (e.g. fast-restart), the relaunch is skipped.

## [0.17.3] - 2026-05-03

### Fixed

- **`anima pause` now handles started sandboxes**. v0.17.2 issued `/archive` directly against `started` state and Daytona returned 400 "Sandbox is not stopped" (verified live on enigma during canary). `ensureSandboxArchived` is now a two-phase state-machine: phase 1 stops the sandbox if it's `started`/`starting` (60s deadline), phase 2 archives the now-stopped sandbox (60s deadline). The result struct gains a `stoppedFirst: boolean` flag so callers can tell whether the two-phase path was taken. Live canary then succeeded.

## [0.17.2] - 2026-05-03

### Added

- **`anima pause` command**: archives a started sandbox to stop the runtime burn during dev gaps. Sandbox UUID + endpoint preserved; resume via `anima resume` (~2-5 min cold restore). Does NOT require operator-keystore unlock, only the operator wallet to sign the archive HTTP request. Pairs with `anima resume` for full lifecycle control between dev sessions.
- **Harness self-heartbeat**: the harness now self-pings its own public proxy URL every 30 minutes by default. Each ping hits Daytona's reverse proxy, refreshing `lastActivityAt` and reducing the chance of a healthy sandbox accidentally tripping the 60-min `autoArchiveInterval` (which only fires on `state=stopped`, but blips can transition through stopped briefly). Override via `HARNESS_HEARTBEAT_INTERVAL_MS` env var (used in canaries to compress the verification window). Heartbeat failures log warn but never crash; per-ping `AbortSignal.timeout(15_000)` so a stuck proxy can't block harness shutdown.
- **`SandboxProviderClient.archiveSandbox(id)`**: signed POST to `/api/sandbox/:id/archive` with `action=archive`. Mirrors `stopSandbox` / `startSandbox` patterns.
- **`ensureSandboxArchived` helper** in `sandbox-provision.ts`: pure state-machine wait (60s default) for `state=archived`. Acceptable transient: `archiving`. Throws on `error`. Used by `anima pause` to confirm Daytona acknowledges the archive.

### Why these primitives matter

Every active 0G Sandbox burns ~0.09 0G/hour (= 2.16 0G/day per 1 CPU + 1 GB). For a 13-day hackathon that's ~28 0G if always-on. With `anima pause` between dev sessions (12 h/day idle = ~13 0G saved over the hackathon), runway extends to ~22 days theoretical at the same deposit. The heartbeat is the autonomic complement: keeps healthy sandboxes from accidentally entering `stopped → archived` cycles when the operator is mid-session.

## [0.17.1] - 2026-05-03

### Added

- **`anima resume` command**: wakes a stopped or archived sandbox and re-handoffs the agent privkey to the (newly restarted) harness. Same sandbox UUID + endpoint preserved. ~30s for stopped sandboxes, 2-5 min for archived sandboxes (Daytona restores filesystem from object storage). Use whenever the harness goes offline (Daytona auto-archive after 60 min idle, or `INSUFFICIENT_BALANCE` settlement event).
- **`anima topup --provider <amount>`**: deposit 0G into the Galileo SandboxServing settlement contract for the operator wallet. Use to refill runtime burn budget (~0.09 0G/hour per active sandbox). Interactive `anima topup` adds a third option alongside `agent` (EOA gas) and `compute` (0G Compute ledger).
- **`ensureSandboxStarted` / `resumeArchivedSandbox`** exported helpers in `sandbox-provision.ts`. State-aware polling that handles every Daytona transition: `stopped → started` (60s), `archived → restoring → started` (5min), `starting`/`restoring`/`pulling_snapshot` (poll without re-issuing /start). Single source of truth for "ensure sandbox is alive + harness is ready".
- **`SandboxProviderClient.requestTimeoutMs`** config: per-request fetch deadlines (read 30s, write 60s default), applied via `AbortSignal.timeout` on every attempt. Without these, a stuck Daytona backend would hang the CLI for minutes.

### Fixed

- **`anima upgrade` (in-place mode) hung on archived sandboxes**. v0.17.0 polled only 60s for state=started, but `archived → restoring → started` takes minutes (Daytona restores filesystem from object storage). v0.17.1 uses the new `ensureSandboxStarted` helper which gives a 5-minute deadline when source state is archived. Caught live on May 3 2026: enigma was archived overnight by 0G's settler after a `INSUFFICIENT_BALANCE` voucher event (block 31185427, May 2 23:06:58 UTC), v0.17.0 hung for 3 minutes, v0.17.1 with state-aware deadlines + matching `restoring`/`starting` intermediate states completes the flow correctly.
- **No fetch timeout on `SandboxProviderClient`**: every method (createSandbox, startSandbox, execInToolbox, etc.) used raw `fetch` with no `AbortSignal`. A stuck Daytona backend would hang indefinitely. Now every method uses `AbortSignal.timeout(...)` per attempt with sensible defaults; configurable via `requestTimeoutMs`.
- **No pre-flight balance check** on Galileo deposit before upgrade or resume. Upgrades would proceed and burn the keystore-unlock signature, then fail mid-flow when `runSandboxProvision`'s deposit step hit the contract floor. v0.17.1 reads `getBalance` up-front; if below 2× `min_balance` (0.12 0G), aborts with a clear `anima topup --provider 1` suggestion.

### Live root-cause data (this changelog references chain evidence)

The May 2 2026 enigma archive was directly caused by Galileo testnet deposit running out (`compute_price_per_sec=0` is the FLAT rate but per-CPU + per-GB-mem charges accumulate to ~0.0015 0G/min = 0.09 0G/hour for our 1 CPU + 1 GB sandbox = 2.16 0G/day). 353 successful vouchers settled 17:54-23:06 May 2 UTC; voucher #3245 at 23:06:58 returned `INSUFFICIENT_BALANCE`. 0G's settler dispatched a StopSignal → `runStopHandler` ran `dtona.StopSandbox → WaitStopped → ArchiveSandbox`. The 60-minute Daytona auto-archive cron was NOT involved (it requires `state=stopped`, which only happened AFTER the settler stopped the sandbox).

## [0.17.0] - 2026-05-03

### Changed

- **`anima upgrade` defaults to in-place**: rolling the sandbox harness to a new ref now does `git fetch + checkout + bun install + harness restart` inside the existing Daytona container instead of swapping to a fresh one. ~30-60s downtime, $0 testnet cost, same sandbox UUID + endpoint. The container-swap path moves behind a new `--reprovision` flag, reserved for the future when sealed mode + image-hash attestation are wired up.
- **Why**: per `feedback-anima-is-unsealed-currently.md`, anima's Phase 11 deployment is unsealed (generic `daytonaio/sandbox:0.5.0-slim` image, software-generated harness keypair, no SANDBOX_SEAL_KEY). Heavy reprovision was buying no real attestation freshness, only ~0.9 0G testnet burn + 60-90s downtime per release. Over the remaining hackathon × ~5 expected upgrades that's ~4.5 0G testnet wasted on theatrical rotation. Locked design decision in `decision-upgrade-in-place-default.md`.

### Added

- `packages/harness/src/upgrade-script.ts`: new `buildUpgradeScript()` mirrors the bootstrap-script API. Detaches the slow work (git fetch + bun install + harness restart) into a `nohup` background subshell so the toolbox `process/execute` 60s ceiling never bites. All slow network steps wrapped in the same `retry()` shell function bootstrap uses (3-attempt linear backoff). 20 unit tests including byte-budget regression (`script.length < 5000`).
- `--reprovision` flag on `anima upgrade` for the heavy container-swap path.
- `handoffAgentToHarness()` exported helper in `sandbox-provision.ts`: extracted from `runSandboxProvision` Steps 4-7 (poll `/bootstrap/pubkey` → ECIES envelope → `/bootstrap/provision` → `/healthz` Ready). Shared between fresh-cold bootstrap and in-place-restart paths since the wire-level handshake is identical.

### Migration

- No action needed. End-users on `bun add -g @s0nderlabs/anima@0.17.0` get the in-place default automatically. Old behavior is `anima upgrade --reprovision`.

## [0.16.8] - 2026-05-02

### Fixed

- **Bootstrap retry coverage closes last 2 transient classes**: `apt-get update`, `apt-get install`, `curl bun.sh/install`, and `bun install --frozen-lockfile` are now wrapped in a generic `retry()` shell function with 3-attempt linear backoff (5s, 10s). The existing `git clone` inline retry (v0.16.4) was refactored to use the same function via a `git_clone_one()` helper that bundles the workspace-wipe with the clone so cleanup runs every attempt. Closes the `apt-install-failed` + `bun-install-failed` transient classes seen during enigma upgrade attempts on May 2 2026, the 2 remaining uncovered Daytona transients after v0.16.4-v0.16.6 shipped retries for git-clone, harness cold-start, and port-8080.
- **Byte-budget regression test**: outer script size now asserted `< 5000` bytes in unit tests so any future field/comment/extraApt growth that risks Daytona's request-size ceiling fails CI before it ships (the v0.16.5 → v0.16.6 → v0.16.7 saga lesson: 5340 worked, 6136 broke). v0.16.8 outer script measures 3880 bytes (1460-byte headroom).

### Changed

- Stripped the harness-launch comment block (rationale lives in memory files now per the v0.16.7 lesson). Net script size dropped 4308 → 3880 bytes despite adding 4 retry wrappers; the generic `retry()` function is shorter than the inline retry loop it replaced.

## [0.16.7] - 2026-05-02

### Fixed

- **Bootstrap script size**: v0.16.6's added inline comments and apt-list change pushed the generated bootstrap script from 5340 bytes to 6136 bytes, which crossed Daytona's toolbox `process/execute` request limit (`400 Request Header Or Cookie Too Large`). Verified May 2 2026 via enigma upgrade attempt that failed twice in a row on v0.16.6. Stripped the inline comments (the `feedback-*.md` memory files retain the rationale), keeping all the v0.16.4 git-clone retry + v0.16.5 harness retry + v0.16.6 port-kill behavior. New script size: 4288 bytes (under the prior v0.16.5 ceiling of 5340). Tests updated to match the simplified output.

## [0.16.6] - 2026-05-02

### Fixed

- **Bootstrap port conflict**: harness launch now explicitly frees port 8080 (`fuser -k 8080/tcp`) both before the launch and at the start of each retry attempt. Some Daytona snapshot revisions ship a default service on 8080 that blocked the harness from binding, surfacing as `harness-died-early — Is port 8080 in use?` even with the v0.16.5 retry coverage. `psmisc` added to the apt install list so `fuser` is available. Also covers stale-PID scenarios from any prior failed launch in the same bootstrap (defensive — should not happen with the v0.16.5 retry but cheap to handle). Verified May 2 2026 enigma upgrade: 2 attempts hit EADDRINUSE on the new container, third succeeded only because the squatting service died on its own. With the explicit port-kill, the first attempt would have succeeded.

## [0.16.5] - 2026-05-02

### Fixed

- **Harness launch resilience**: bootstrap script now retries the harness daemon launch up to 3 times with 5s backoff, and the per-attempt liveness wait bumped from 3s to 10s. Verified May 2 2026 during oracle iNFT #9 init: even though git-clone + bun-install + bun runtime were all healthy, the post-launch `kill -0` check at sleep 3 occasionally raced bun's cold-start (importing core + plugins + viem under Daytona's container can take longer than 3s), surfacing as `harness-died-early` even when the daemon would have come up fine. With the new retry + longer wait, that race is invisible. Each failed attempt also dumps the harness log into the bootstrap progress log so future failures self-diagnose without needing container access.

## [0.16.4] - 2026-05-02

### Fixed

- **Sandbox bootstrap resilience**: `git clone` inside the harness bootstrap script now retries up to 3 times with 5s/10s exponential backoff before declaring `git-clone-failed`. Earlier versions failed-fast on the first transient (github.com rate-limit on shared Daytona IPs, or container DNS not yet warm). Discovered May 2 2026 during wraith iNFT #8 npm-distributed full-flow validation: first `anima init` sandbox attempt failed at git-clone, `anima deploy` retry succeeded ~2 min later. With this fix, the same transient is invisibly absorbed by the inner retry loop. Workspace dir is wiped between attempts so partial-clone state can't poison the next try.

## [0.16.3] - 2026-05-02

### Fixed

- **Critical**: published `@s0nderlabs/anima-plugin-onchain` was missing the `abis/` and `data/` directories. The package's `files` array was set to `["src", "README.md"]`, but `src/abis.ts` does `import factoryJson from '../abis/factory.json' with { type: 'json' }` (and similar for `quoter`, `swap-router`, plus `src/tokens.ts` imports `'../data/tokens.json'`). Both directories sit at the package root, so they were stripped from the published tarball. Effect: any chain tool that loaded an ABI (transfer, swap, stake, balance, analysis, generic) crashed at module-load time with `Cannot find module '../abis/factory.json'`. The `--version` command tripped this on every fresh `bun add @s0nderlabs/anima` install. Fixed by setting `files: ["src", "abis", "data", "README.md"]`. All 6 packages republished at 0.16.3 because changesets `fixed` group keeps versions linked.

### Added

- **Audit rule**: `feedback-publish-files-must-include-non-src-assets.md` documents the class of bug to prevent future regressions. Pre-publish audit must check every `'../<dir>/'` import in `src/` against the package's `files` field, in addition to the existing dep audit.

## [0.16.0] - 2026-05-02

### Added

- **First npm publish.** All 6 workspace packages are now published to npm under the `@s0nderlabs` scope. End user install path is now:
  ```bash
  bun add -g @s0nderlabs/anima
  anima init
  ```
  Packages: [`@s0nderlabs/anima`](https://www.npmjs.com/package/@s0nderlabs/anima) (CLI binary, was `@s0nderlabs/anima-cli`), [`@s0nderlabs/anima-core`](https://www.npmjs.com/package/@s0nderlabs/anima-core), [`@s0nderlabs/anima-harness`](https://www.npmjs.com/package/@s0nderlabs/anima-harness), [`@s0nderlabs/anima-plugin-comms`](https://www.npmjs.com/package/@s0nderlabs/anima-plugin-comms), [`@s0nderlabs/anima-plugin-onchain`](https://www.npmjs.com/package/@s0nderlabs/anima-plugin-onchain), [`@s0nderlabs/anima-plugin-system`](https://www.npmjs.com/package/@s0nderlabs/anima-plugin-system).
- **Per-package metadata polish**: each package gets `description`, `license: "MIT"`, `repository`, `homepage`, `bugs.url`, `keywords`, `publishConfig: { access: "public" }`, `engines: { bun: ">=1.1" }`, `files: ["src", "bin", "README.md"]`, and a per-package `README.md`.
- **`.npmignore` per package** excluding `*.test.ts`, `*.test.tsx`, `__tests__/`, `*.tsbuildinfo`, `node_modules` to keep tarballs small.
- **`@s0nderlabs/anima-harness` added to `tsconfig.json` references** (was missing; latent bug).
- **`changesets` `fixed` group**: all 6 packages are version-locked. Single `bun changeset version` bumps them all together.
- **`.github/workflows/release.yml`**: tag-triggered (`v*`) workflow that runs typecheck + lint + tests + forge then publishes each package to npm via `bun publish --access=public` in topological order, then creates a GitHub release with auto-generated notes.

### Changed

- **CLI package renamed** from `@s0nderlabs/anima-cli` → `@s0nderlabs/anima` (shorter install string while staying scoped). The bin name `anima` is unchanged.
- **Runtime requirement documented**: anima requires `bun >= 1.1`. Node-only consumers are out of scope until a Node-compatible build pipeline is added.

### Verification

- `bun typecheck`, `bun lint`, `bun test --timeout 30000 packages/*/src` — all green.
- `npm view @s0nderlabs/anima version` returns `0.16.0` (and same for the 5 other packages).
- Clean tempdir: `bun add @s0nderlabs/anima` followed by `node_modules/.bin/anima help` prints the help screen without error.

## [0.15.6] - 2026-05-02

### Added

- **Fund-recovery CLI for retiring agents.** Two new commands close the gap where a decommissioned agent's compute ledger and EOA balance had no operator-friendly drain path; previously required a custom Bun script.
  - `anima ledger [balance | refund | retrieve | close]` operates on the agent's 0G Compute ledger. `balance` prints main + per-provider sub-account state including pendingRefund. `retrieve` calls `retrieveFund('inference')` to start the per-provider lock window. `refund [--amount N | --all]` calls `LedgerProcessor.refund` to withdraw from the main account back to the agent EOA (`--all` reads `availableBalance` and refunds the lot). `close --yes` calls `deleteLedger` to fully decommission. Validates that the requested amount fits the available balance before submitting, and points operators at `ledger retrieve` when funds are still locked in provider sub-accounts.
  - `anima drain --to <addr>` sweeps the agent EOA's native balance to a target address, default operator. Reads live `eth_gasPrice` (with the standard 4 gwei floor), reserves `21000 * gasPrice` for the sweep tx itself, sends `balance - reserve`, and prints the explorer URL. New core helper `drainAgentEOA` plus an extracted pure helper `computeSweepAmount` for unit-testable balance/reserve math.
- New core exports: `getLedgerDetail`, `refundFromLedger`, `retrieveLedgerFunds`, `closeLedger`, `drainAgentEOA`, plus types `ProviderSubAccount`, `DrainAgentResult`. Test hook `setBrokerFactoryForTests` allows injection of a stub broker to unit-test ledger helpers without RPC.
- 10 new unit tests: 4 for `computeSweepAmount` (default reserve, below-reserve error, override, error wording) and 6 for the ledger helpers (missing ledger, balance + provider list, getProvidersWithBalance throw tolerance, refund/retrieve/close call shape).

### Verification

- 508 unit tests pass (+10 new); typecheck + lint clean; CLI help lists the new commands; `anima ledger badsub` rejects unknown subcommands cleanly; `anima drain` smoke-prints balance + target before the destructive confirm.
- End-to-end fund recovery on phantom (mainnet iNFT #7) deferred to live drive after this commit lands.

## [0.15.5] - 2026-05-02

### Fixed

- **Orphan sandbox blocks `anima init` / `anima deploy` retry on name conflict.** When `runSandboxProvision` partially succeeds (sandbox created but bootstrap fails), the operator's retry hits HTTP 409 "Sandbox with name X already exists" and there's no CLI affordance for cleanup. New `createSandboxWithOrphanRetry` helper detects the 409, lists sandboxes by name, deletes the orphan, and retries `createSandbox` once. Keeps OOB recovery clean without exposing operators to raw provider API or a manual cleanup CLI. Surfaced live during the v0.15.4 phantom fresh-init verification on Galileo. Also: `SandboxRecord` interface now declares the `name` field that the Daytona provider already returns (was missing from the type).
- **Init wizard: keychain-service text prompt pre-fills the default value, so typing extends instead of replacing.** Operator enters `dev.deployer` at a prompt showing default `anima.operator` and the wizard concatenates them into `anima.operatordev.deployer`. Caused live during phantom init drive — operators with non-default keychain names couldn't get past the prompt without a Ctrl+U workaround. Removed the redundant `initialValue: 'anima.operator'` (kept the `placeholder` so the example still appears as ghost text); typing now starts from an empty buffer.
- **Brain answers URL-fetch prompts from training data instead of calling `web.fetch`.** v0.15.4 enigma drive showed qwen3.6-plus responding with stale training-data answers ("0G TypeScript SDK", "Update README.md") for `fetch the json from <url>` prompts, no `web.fetch` tool-call entry in activity.jsonl. Tightened the system-prompt clause for HTTP GETs with explicit anti-training-bias wording: "Whenever the operator gives you a URL — even one you 'recognize' (github API, popular docs, news sites) — fetch the URL. Your training data is stale and the live response may differ; never recite an answer for content behind a URL without fetching it." Frozen-prefix change invalidates the 0G Compute prompt cache once on next session start (one-time cost, then re-warms).

### Added

- 5 new unit tests in `sandbox-provision.test.ts` covering `createSandboxWithOrphanRetry`: first-try success, 409+cleanup+retry success, non-409 propagation, anonymous-create propagation, empty-list re-throw.

### Verification

- 498 unit tests pass (+5 new); 124 forge tests pass; typecheck + lint clean; 6/6 CLI smoke probes pass.
- Live verification on enigma deferred to post-tag — `anima upgrade --version v0.15.5` will deploy the new prompt + orphan-retry to enigma, after which the URL-fetch + cleanup paths can be re-driven.

## [0.15.4] - 2026-05-02

### Added

- **Phase 11.5 boot-time memory restore from 0G Storage.** New `packages/harness/src/memory-restore.ts` runs in `buildAnimaRuntime` between memory-dir creation and `brain.init`: pulls all anchored `IntelligentData` slots (`memory-index`, `identity`, `persona`, `activity-log`) from the iNFT contract, downloads each blob via `downloadBlobByRoot`, decrypts with `deriveMemoryKey(agentPrivkey)`, and writes back to disk. Closes the v0.15.0-era gap where every fresh container boot saw an empty memory dir even though prior sessions had anchored content via `MemorySyncManager.flushTurn` and `iNFT.updateSlots`. Per-slot best-effort: missing blobs / decrypt errors / RPC failures log a warning but never block boot. Local non-empty files always win, protecting writes that haven't flushed to chain yet (e.g. supervisord-restart between flush and tx-confirm). Slots run in parallel — saves 9-15s on the indexer-degraded path with 4 restore targets.

### Fixed

- **`downloadBlobByRoot` / `downloadBlobViaDiscoveredNodes` had no per-fetch timeouts** — a single hung TCP connection in the SDK indexer call, the `indexer_getShardedNodes` RPC, the parallel `zgs_getFileInfo` probes, or the serial `zgs_downloadSegmentByTxSeq` candidate-walk could pin harness boot indefinitely. Added wall-clock deadlines (SDK 30s, node-list 10s, per-node probe 5s, segment download 30s) via `AbortSignal.timeout` on every `fetch`, plus `Promise.race` + `clearTimeout` around the SDK call (no AbortSignal support upstream). Without this, v0.15.4's restore path would amplify any indexer issue into "harness never reports Ready". Surfaced by /simplify efficiency-review agent during v0.15.4 ship.

### Verification

- 493 unit tests pass (+7 new for `memory-restore`); 124 forge tests pass; typecheck + lint clean; 6/6 CLI smoke probes pass.
- Live verification deferred to post-tag drive on enigma via `anima upgrade --version v0.15.4`. The restore path activates on the new container's first boot, so the deploy itself exercises both the v0.15.4 restore feature AND the v0.15.3 stableStringify-on-upgrade fix end-to-end (the upgrade flow itself was the unfixed bug last time).
- Pre-existing `as any` lint flags in `packages/plugin-comms/src/pubkey-resolver.test.ts` (7 sites) cleaned up to `as unknown as PublicClient` so the lint gate is fully green.

## [0.15.3] - 2026-05-02

### Fixed

- **`anima upgrade` always failed with `provision-rejected: sig-mismatch`.** Surfaced live during the v0.15.2 enigma upgrade. `stableStringify` in `packages/harness/src/auth.ts` (the deterministic config hasher both sides of the provision sig run against) emitted `"key":undefined` literal text for any object property whose value was `undefined`. The CLI signs over the in-memory `RuntimeConfig` (where `runSandboxProvision` always sets `promptAppend: opts.promptAppend`, which is `undefined` when no prompt-append config is wired in), JSON.stringify then drops the field on the wire, and the harness's parsed config has no `promptAppend` key — so the harness's `stableStringify` produced a different string than the CLI's. Fix: skip `undefined`-valued keys in object stringification, matching `JSON.stringify` semantics. Regression test `survives JSON.stringify→parse roundtrip` pins the bug. v0.15.0 init initially worked because the env var wasn't unset; the path bit on every subsequent `anima upgrade`.

### Verification

- 13 auth-tests pass (was 11 + 1 new regression).
- enigma re-handed-off via `test/local/finish-enigma-handoff.ts` (which omits `promptAppend` so it sidesteps the bug) — same agent EOA `0xd56b...9683`, same iNFT #6, MEMORY.md preserved. New sandbox `75ec419a-ea9e-49f7-8180-8c26c0604635` running v0.15.2 code with the workspaceRoot fix; `shell.run` + `code.execute` (python) verified end-to-end via tmux window 3, activity-log evidence: `cwd: "/home/daytona/anima"` (the v0.15.2 cwd fix proven on the sandbox path).

## [0.15.2] - 2026-05-02

### Fixed

- **Shell-class tools (`shell.run`, `code.execute`, `shell.process_*`) failed in 0G Sandbox containers with `posix_spawn '/bin/sh': ENOENT`-style errors.** Root cause traced via live diagnostic against enigma's container (Galileo, sandbox `86e3f5f3-...`): bun + node spawn worked fine against `/bin/sh`, `date`, `/usr/bin/date`, plus PATH lookups. Real cause was `packages/harness/src/build-runtime.ts:204` defaulting `workspaceRoot` (the cwd passed to `child_process.spawn`) to `/opt/anima` — a path that doesn't exist because the bootstrap script clones to `$HOME/anima` (= `/home/daytona/anima`), since the Daytona container runs as the unprivileged `daytona` user with no sudo for `/opt/`. When `options.cwd` doesn't exist, posix_spawn fails with ENOENT and the kernel attributes the error to argv0, not the missing cwd. Fix: default `workspaceRoot` to `process.cwd()`, matching local-mode `chat.tsx`. The bootstrap script does `cd "$ANIMA_DIR"` before launching the harness, so `process.cwd()` already points at the cloned repo.

### Added

- **`ANIMA_PERMISSIONS` env override.** New `pickPermissionMode()` helper in `packages/cli/src/commands/init/sandbox-provision.ts` reads the env var (case-insensitive, trimmed) and returns one of `'off' | 'prompt' | 'strict'` (canonical `PermissionMode` from `@s0nderlabs/anima-core`). Unknown / unset values fall back to `'off'` (autonomous default). Operators can now drive the y/s/n approval-modal SSE bridge against a sandbox-deployed agent without editing source. Used by both `anima init` and `anima upgrade` since both call `runSandboxProvision`.

### Verification

- 485 unit tests + 124 forge tests + 3 new `pickPermissionMode` tests pass; typecheck + lint clean.
- `bootstrap.test.ts` adds an assertion pinning `ANIMA_DIR="$HOME/anima"` (not `/opt/anima`) plus `rm -rf "$ANIMA_DIR"` (always-clone semantic).
- Stale `/opt/anima` doc-comments in `bootstrap.ts:22` removed.
- Live tmux drive on enigma deferred to post-tag (bootstrap clones from a github ref); will be appended in v0.15.2 ship-doc memory after `anima upgrade --version v0.15.2` deploys to the running enigma container.

## [0.15.1] - 2026-05-02

### Fixed

- **Eleven bootstrap + retry + auth fixes from the live `enigma` deploy on 0G Sandbox (Galileo).**
  - Daytona's `process/execute` returns `{exitCode, result}`, not `{stdout, stderr}`. `ToolboxExecResponse` now types both shapes, `extractExecOutput()` helper normalizes, all callers in `sandbox-provision.ts` + `logs.ts` use it.
  - 60s exec cap blew up cold-start bootstrap (apt + bun + chromium ≈ 3-5 min). Outer script now `bash -c '<base64-decoded inner | nohup &>'` returns in <2s; caller polls `/tmp/anima-bootstrap-{done,failed}` markers.
  - Daytona splits commands argv-style (no shell). All multi-step ops wrapped in `bash -c`; inner subshell base64-encoded to avoid quote-escape soup.
  - Bash `&` followed by `&&` was a syntax error; restructured to `... & echo bootstrap-launched`.
  - Container runs as unprivileged `daytona` user. Bootstrap now `sudo -n apt-get`, clones to `$HOME/anima` (not `/opt/anima`), logs to `$HOME/anima-logs/`.
  - 504 Gateway Timeout from Daytona upstream: `SandboxProviderClient.#fetchWithRetry` retries 502/503/504 × 3 with linear backoff; non-idempotent `createSandbox` retries safely because 504 means upstream never received it.
  - `401 nonce already used` on retry: retry helper now mints FRESH signed-request envelope (fresh nonce + expiry) per attempt via `buildInit()` closure.
  - `401 request expired` after slow retries: bumped default expiry 60s → 300s in `og-sandbox/auth.ts`.
  - `Transaction receipt not found` on Galileo deposit + ack: wrapped in `waitForReceiptResilient(60×2s)`.
  - Bootstrap marker false-positive triggered by `bash setlocale` warning prefix: parser now matches `BOOTSTRAP_FAIL_KEYWORDS` substrings (single source of truth, exported from `@s0nderlabs/anima-harness`).
  - Coalesced bootstrap poll: 3 separate exec calls per tick → 1 with sentinels (`echo --F--; cat fail; echo --D--; cat done; echo --P--; tail`). Cuts ~280 HTTP+sign roundtrips → ~120 on a 10-min bootstrap.
- Repository made public (was previously private; bootstrap clones anonymously now, no PAT support needed).

### Verification

`enigma` mainnet iNFT #6 deployed live to Galileo Sandbox `86e3f5f3-...`. Three tools verified end-to-end via tmux: `chain.balance`, `memory.save` (+ per-turn 0G Storage flush + iNFT updateSlots anchor), `agent.message` A2A to specter (tx `0xddc7b...37aac8bf`). Endpoint published as `agent:endpoint` text record on `enigma.anima.0g`.

## [0.15.0] - 2026-05-01

### Added

- **Phase 11: 0G Sandbox deployment.** New `@s0nderlabs/anima-harness` package implements the harness daemon that runs inside an attested TDX TEE container on 0G Sandbox (Galileo testnet). State machine `Bootstrapping → Provisioned → Ready → ShuttingDown`; EIP-191 signed `/chat`, `/sync`, `/approval/:id/respond` endpoints; SSE `/events` with last-event-id reconnect; `ApprovalRelay` bridges harness PermissionService to operator's TUI modal.
- **Laptop CLI sandbox client** (`packages/cli/src/sandbox/client.ts`): wraps the harness HTTP API with operator-signed envelopes; consumed by `chat-sandbox.tsx` (sandbox-mode chat loop), `status`, `logs`, `sync`, `deploy`, `upgrade`.
- **0G Sandbox provider HTTP client** (`packages/core/src/og-sandbox/`): EIP-191 signed-header auth + retry; `SandboxProviderClient.createSandbox/getSandbox/listSandboxes/deleteSandbox/execInToolbox`. `SandboxSettlementClient` for the Galileo settlement contract `0xd7e0CD227e602FedBb93c36B1F5bf415398508a4`.
- **`anima init --target sandbox`** wizard branch: deposits 1 0G to provider, acknowledges TEE signer, creates sandbox via `daytonaio/sandbox:0.5.0-slim`, runs bootstrap, mints iNFT on mainnet, funds agent EOA, runs Option 3 ECIES handoff to harness, claims subname, publishes endpoint URL as `agent:endpoint` text record.
- **`anima deploy`** command rewritten from stub to live Local→Sandbox migration via Option 3 (operator decrypts existing keystore, agent privkey re-handed to fresh harness).
- **`anima upgrade`** new command: deletes old sandbox + creates fresh container at the latest version, preserves agent identity + memory via Option 3 re-handoff. Updates `agent:endpoint` text record. ~60-90s downtime per upgrade.
- **Sandbox-mode `status` / `logs` / `sync` proxies**: status hits `/healthz` + provider's `getSandbox`; logs tail `~/anima-logs/anima-harness.log` via toolbox exec; sync POSTs `/sync` to the harness which calls `MemorySyncManager.flushAll`.
- **`RealRuntime`** in harness: builds full anima stack inside the container (OGComputeBrain + ToolRegistry + plugins + listeners + MemorySyncManager). Mirrors local-mode chat.tsx setup minus TUI; tool indicators stream via EventHub `tool-call-start/end` SSE events.

### Verification

`enigma` agent: mainnet iNFT #6 (mint tx `0x92233329...`), agent EOA `0xd56b...9683`, subname `enigma.anima.0g`, harness running in 0G Sandbox TDX TEE on Galileo, operator a thin client. Architecture verified end-to-end via tmux drive: laptop TUI → POST /chat (signed) → harness in TEE → brain.infer (0G Compute mainnet) → tools → SSE back to TUI.

## [0.14.1] - 2026-05-01

### Fixed

- **Approval modal body rendered `(unspecified)` for every value-moving onchain kind.** `summarizeApprovalSubject` only checked `command`/`path`, so chain.send/swap/stake/write all dropped the friendly text in the modal. The sys row above had it (via `describePermissionCheck`), but the modal box itself was useless. Caught live on specter mainnet during the post-v0.14.0 prompt-mode drive. Bodies now render `send 0.001 0G to 0xC635…87Ec`, `0.01 0G→W0G`, `swap 0.0005 0G→USDCe`, `0.011 0G→stOG`, `transfer(address,uint256) (value: 1 wei) on 0x9e71…4721`, etc.
- **Permission deny path returned no `reason`, so brain hallucinated `"queued for approval"` after operator pressed `n`.** `applyDecision` deny branch now sets `reason: 'rejected in approval modal'`. Brain-facing error text rewritten with explicit "do NOT retry, instruct another tool, or claim the transaction is queued. Surface the rejection to the operator" guidance. Brain replies are now correct: "rejected, would you like to retry?".
- **iNFT `mintBlock` auto-backfill caught a wrong existing value.** specter's config had `mintBlock: 31365203` (predates token 1's mint at block 31365569). `discoverMintBlock` walked from chain head and returned the actual mint at block 31560769; cast-verified by matching `Transfer(0x0, *, tokenId=4)`.

### Added

- **`/exit` and `/quit` slash commands.** Graceful TUI exit through `handleExit` (drains 0G storage flush, kills MCP servers + background processes, releases the process). `/help` lists `/exit`. Was Ctrl+C only.
- **`packages/cli/src/util/format.ts` shared `shortAddr`.** Three local copies (chat.tsx + model-picker.ts + the new approval-summary.ts) consolidated. New module also handles `undefined`, short, and non-0x inputs (e.g. `.0g` names) safely; the two prior local copies would have thrown on `undefined`.
- New permission `applyDecision` `reason` field on the return type. Tests pin it.

### Changed

- `packages/cli/src/ui/approval-summary.ts` extracted from inline app.tsx. Owns the modal body rendering for every PermissionRequest kind.

### Verification

Drove every Phase 10 modal kind end-to-end on specter mainnet in `prompt` mode (no `--yolo`). 11 fresh mainnet tx hashes covering chain.send (y/s/n + signature dedup per recipient), chain.wrap, chain.unwrap, swap.execute (0G→USDCe + USDCe→0G + USDCe→W0G), stake.stake, chain.write with `value > 0`. Strict mode verified via `approvals: { mode: "strict" }` config + chain.send → `Denied: value-moving tx denied in strict mode`. mintBlock backfill verified by deleting the field and observing config rewrite. 406 unit tests + 124 forge tests pass; lint + typecheck clean.

## [0.14.0] - 2026-05-01

### Added

- **Phase 10: `@s0nderlabs/anima-plugin-onchain` ships 19 brain limbs** for on-chain operations on 0G mainnet. JAINE-only swap routing (Factory `0x9bdcA579..7ef4`, SwapRouter `0x8B598A7C..f2e2`, Quoter V1 `0xd008837..bE02`, W0G `0x1Cd0690f..109c`), Gimo-only LST (pool `0xac06d1df..2135af`, stOG `0x7bbc63d0..1404`), Multicall3 universal `0xcA11bde0..76CA11`. No new contracts deployed; all integration with existing 0G primitives.
- **Wallet/account**: `account.info` (single-call snapshot bundling agent EOA + iNFT + brain provider + balance + recent activity).
- **Balance**: `chain.balance` discovers tokens via Transfer-event scan + Multicall3 batched `balanceOf` (no curated list); caches at `<agentDir>/onchain/tokens-cache.json`.
- **Tokens**: `tokens.info` resolves symbol/address with priority cache → vendored JAINE list → on-chain ERC-20 reads.
- **Transfers**: `chain.send` (auto-detects native vs ERC-20 by token symbol), `chain.wrap`/`chain.unwrap` for native ↔ W0G via WETH9 deposit/withdraw.
- **Trading**: `swap.quote` (3-tier scan via JAINE Quoter V1) + `swap.execute` (re-quotes at exec time; auto-approves router for ERC-20 input; native via `multicall([exactInputSingle, refundETH])`; native-out via chained `unwrapWETH9`). Quote and allowance race in parallel.
- **Stake**: `stake.stake`, `stake.unstake`, `stake.claim`, `stake.position` against Gimo. Min 0.01 0G hard-floor. Unstake queues a withdrawal; cooldown ~72h. `stake.claim` decodes `0xd6d9e665` revert into "claimable in ~Xh" friendly error.
- **Blockchain**: `chain.block` (block summary at any tag/number), `chain.gas` (current gas price with floor).
- **Analysis**: `chain.tx` (decode any tx via vendored ABIs first, 4byte directory fallback with canonical-first spam filter, cached at `<agentDir>/onchain/4byte-cache.json`); `chain.contract` (bytecode + EIP-1967 proxy slot + ERC-165 + ERC-20 detection); `chain.activity` (Transfer events for any address, in + out, sorted newest-first).
- **Generic**: `chain.read` (eth_call by signature), `chain.write` (state-changing call by signature). Both gated by approval modal in `prompt` mode.
- **`ONCHAIN_GUIDANCE` plugin prompt section** wired through `extraGuidance` (mirrors `MARKETPLACE_GUIDANCE` from Phase 8). Always-on when plugin-onchain is loaded.
- **PermissionRequest extended** with new kinds (`chain.send`, `chain.swap`, `chain.stake`, `chain.write`) plus optional `amount`, `recipient`, `token` fields. Modal renders friendly "send 0.05 0G to 0xC635…" instead of raw command. `strict` mode denies value-moving txs; `prompt` always asks; `yolo` is operator-explicit.
- **`discoverMintBlock` helper** auto-backfills `INFTRef.mintBlock` at chat boot when absent: chunked rawGetLogs scan from chain head backwards (50k-block × 30-chunk cap), persists to `~/.anima/config.ts`.
- **30 unit tests** in plugin-onchain (`tokens.test.ts`, `swap.test.ts`, `analysis.test.ts`, `constants.test.ts`). 6 integration scripts in `test/local/e2e-onchain-*.ts` driving real mainnet via `_onchain.ts` bootstrap.

### Changed

- **Plugin filter in chat.tsx** now loads `'onchain'` (was filtered out as empty); plugin contributes 19 tools when `OnchainRuntimeContext` is supplied.
- **`describePermissionCheck`** refactored from a 90-line if-ladder to a table-driven map (`PERMISSION_DESCRIBERS`) covering all gated tools.
- **`balances.ts` ERC-20 metadata fetch** parallelized via `Promise.all` over discovered addresses (was sequential, 20 round-trips for 20 tokens).
- **`writeLastScannedBlock`** now skips the file write when the head hasn't advanced past the cached cursor.
- **Vendored JAINE ABIs** (`packages/plugin-onchain/abis/{swap-router,quoter,factory,erc20,weth9,multicall3,gimo-pool,stog}.json`) + canonical token list (`packages/plugin-onchain/data/tokens.json`).
- **`waitForReceipt` helper** (1.5s poll, 90s timeout) replaces viem's `waitForTransactionReceipt` for write paths — works around 0G mainnet RPC's intermittent receipt-not-found windows on freshly-mined txs.

### Fixed

- **`getLogs` topic-stripping workaround** via new `rawGetLogs` helper in plugin-onchain. viem v2's `getLogs` strips sparse topic positions when no `event` arg is supplied; against 0G mainnet this falls through to `topics:[]` which the RPC rejects with "result set exceeds 10000 logs". `rawGetLogs` sends the JSON-RPC payload verbatim, preserving `[topic0, null, indexed_addr]` shape exactly. Used in `balances.ts` discovery, `gimo.ts` Unstake event scan, `tools/analysis.ts` chain.activity, and `mint-block.ts`.
- **`pickCanonical` 4byte-spam filter**: removed dead `lc` score (regex `/^[a-z0-9]+$/i` matched everything thanks to the `i` flag, defeating the casing tiebreaker).
- **`decodeCalldata` cache hit**: was returning `source: decoded ? 'cache' : 'cache'` (both branches identical). Simplified to a constant `'cache'` source label.
- **Gimo Unstake event topic** corrected: vendored ABI declared `Unstaked(address,uint256,uint256)` but the deployed contract emits `Unstake(address,address,uint256,uint256,uint256)` (different name + 5 args). Pinned the actual topic hash `0xfe7007b2..a32` so filtering works regardless of the partial ABI mismatch.

## [0.13.0] - 2026-04-30

### Added

- **Phase 8: AnimaMarket escrow.** New native-0G fixed-price escrow contract `AnimaMarket.sol` (`0x3ebD21f5dd67acDeF199fACF28388627212bA2aB` on mainnet + testnet via CREATE2; deploy tx `0x72de913e0e8062255a4625ef0401ca06f825048e780759558bef48fada58e6b0`). State machine: Funded → Done → (Accepted | Disputed) → Settled. 24h acceptance window after `markDone`, 7d max lifetime, immutable 5% protocol fee to dev.deployer. No relayer, no judge: each agent's local harness signs with its own EOA, msg.sender carries actor identity. Disputes resolve via co-signed `proposeSplit` (matching hashes settle automatically) or default-refund-to-buyer at MAX_LIFETIME. forceClose from `Done` settles to provider per claimTimeout semantics (protects negligent providers). 100% line/statement/branch/function coverage on the contract via 62 forge tests + 3-angle security audit.
- **9 brain limbs in `@s0nderlabs/anima-plugin-comms`**: `market.createJob`, `market.markDone`, `market.acceptResult`, `market.dispute`, `market.claimTimeout`, `market.forceClose`, `market.proposeSplit`, `market.getJob`, `market.listMyJobs`. Address resolution shares `resolveAddrOrName` with `agent.message` (`.anima.0g` name → 0x → contact-label fallback).
- **Market lifecycle listener** in `plugin-comms`: catches up `JobCreated` filtered on agent (buyer OR provider) plus 7 lifecycle events (`JobMarkedDone`, `JobAccepted`, `JobDisputed`, `JobSettled`, `SplitProposed`, `SplitResolved`, `JobForceClosed`) in parallel via `Promise.all`. WS subscribes for live events; client-side filter by relevant jobIds.
- **Per-event brain wake-up.** Job lifecycle events drain through a `marketBrainQueue` mirroring inbound A2A: counterparty wakes, actor suppressed (already saw tool response). Settled wakes the recipient so they can send a closing message; splitResolved/forceClosed wake both parties (caller not in event, over-wake preferred over miss). Activity log records `kind:"wake" source:"market" kind:"<event>" jobId:"<id>"` per fire.
- **`MARKETPLACE_GUIDANCE` plugin prompt section.** Always-on protocol guidance injected into the frozen prefix when comms+market are loaded — same pattern as `BROWSER_GUIDANCE`. Anima-controlled, plugin-owned (operator persona stays in `/agent/persona.md`). Tells the brain to negotiate via `agent.message` before funding, look up history on `created` events, deliver before `markDone`, and respond autonomously without operator approval.
- **TUI: dedicated `mkt` row prefix** for market events (lavender), distinct from `inbox` (amber) and `sys` (gray). New `/jobs` slash command lists active escrows. Statusline shows "N escrow" segment when non-Settled jobs exist.
- **Integration scripts** `test/local/e2e-market-happy.ts` + `e2e-market-dispute.ts` exercise the full TS client end-to-end on Galileo testnet with two persistent test wallets (auto-funded from dev.deployer if low). Happy path verified on mainnet: specter↔fox autonomous deal, settled `0xCCeC…d97a +0.00285 0G` fee `0.00015 0G`, with closing thank-you message back to buyer.

### Changed

- **Renamed `gas` → `wallet`** in TUI statusline. The agent EOA holds gas today but will hold trade payments, DeFi receipts, and transfers once Phase 8 marketplace + Phase 10 plugin-onchain ship; `gas` was too narrow. Color thresholds (red <0.005 0G, yellow <0.02 0G) preserved since gas runway is still the floor concern.
- **`resolveAddrOrName` exported from `tools.ts`** so `market-tools.ts` reuses the single resolver chain (was duplicated; now one source of truth).
- **`buildFrozenPrefix` accepts `extraGuidance: readonly string[]`** so plugin-comms contributes MARKETPLACE_GUIDANCE without growing the core's tool-guidance map.
- **`bumpActiveJobs` deduplicates terminal events** by jobId. Force-closing a `Done` job emits both `JobForceClosed` and `JobSettled` (force-close routes through `_settle`); the counter now correctly decrements once per job lifetime.
- **TS rendering helpers** (`formatJobEvent`, `formatJobEventForBrain`, `isParticipant`, `isActor`, `jobEventShouldWakeBrain`, `isJobTerminalKind`) moved from `chat.tsx` into `plugin-comms/market-format.ts`. Protocol semantics live with the protocol code, not in the harness.

## [0.12.2] - 2026-04-29

### Added

- **Agent EOA balance in statusline.** New `gas X.XXX 0G` segment shows the agent's on-chain wallet balance alongside the compute ledger. Refreshed at chat boot, after every brain turn (user-prompted + inbound), and after `/sync`. The agent EOA pays gas for chain writes (`agent.message` inbox.send ≈0.001 0G/send at 4 gwei, sync's `updateSlots` anchor ≈0.005 0G); it typically starves before the compute ledger in long sessions, so it sits before `compute` in the bar. Color thresholds: red below 0.005 0G (~5 sends of runway), yellow below 0.02 0G (~20 sends). Live-verified on mainnet: `0.535 → 0.528` after one `agent.message`, `0.528 → 0.521` after one `/sync` flush.

### Changed

- `viemClients` lifted out of the `comms`-only construction gate so the EOA-balance refresher works regardless of whether the comms plugin is loaded; comms branch reuses the single instance.
- `balanceColor(value, redBelow, yellowBelow)` parameterized so compute (0.5 / 1.5) and EOA (0.005 / 0.02) thresholds share one helper.
- Wei → 0G display conversion uses `formatEther` (already imported) instead of `Number(wei) / 1e18`, matching the convention used in `init`, `topup`, `cost`, and other UI surfaces.
- Paired `getLedgerBalance` + `refreshEoaBalance` call sites collapsed into a single `refreshBalances()` helper at boot, post-user-turn, and post-inbound-turn (3 callsites of duplicated 6-line patterns gone). `/sync` continues to refresh EOA only since it doesn't touch compute.

## [0.12.1] - 2026-04-29

### Fixed

- **Contact-label resolution in `agent.message`** — `sendCore` and `resolveAddrOrName` now fall back to `ContactStore.findByLabel(who)` when `to` is neither an `.anima.0g` name nor a raw `0x` address. Brains naturally write `agent.message(to: "specter")` after seeing it as a contact in `agent.contacts`; the previous code returned `unrecognized recipient format: specter`. New `ContactStore.find(addr)` helper too. Live-verified: fox sent `to=specter` (label-only) directly without retrying.
- **0G Storage replication-lag drops messages** — `resolveInbound` in `storage-spillover.ts` now retries with exponential backoff (8 tries × base 1.5s × 1.5x ≈ 73s budget) when `storage.get(dataHash)` returns null. 0G Storage is eventually-consistent: a sender's `putBlob` returns when the upload tx mines, but indexer/storage-node replication can lag a few seconds; the receiver hits the indexer immediately after seeing the chain event so the first read often misses. Configurable per-message via the new `retry?: { tries, delayMs, backoffMul }` field on `ReceiveChannelInput`.
- **Inbound channel `from=` shows raw EOA instead of `.0g` name** — `DeliveredMessage` now carries `fromLabel: string | null`, set by the listener from `contacts.find(ev.from)?.name`. `formatA2AChannel` renders `<channel ... from="${m.fromLabel ?? m.from}" address="${m.from}" ...>` (preferred display first, raw address still available as fallback attribute), and `formatInboxPreview` shows `from <label-or-shortAddr>`. The brain can now reply via `agent.message(to=specter)` directly.
- **TUI inbox row didn't render mid-turn** — `chat.tsx` `drainInbound` was gated by `state.status() === 'thinking'`, so when an A2A message arrived during a long brain turn the queue grew but no `inbox` row appeared in the operator's transcript. Inbox-row rendering moved to `onInboundDeliver` so display is independent of brain wake-up; `drainInbound` only handles single-flight gating now.
- **Brain runaway: 4+ rephrased copies of one reply** — added explicit guidance in `frozen-prefix.ts`: when `agent.message` returns `{ok: true}`, the message is delivered. Do NOT send a rephrased copy of the same content; one ok = one delivered reply per inbound. (Live observation pre-fix: specter generated 4 alternative wordings of the same reply, all sent on chain.)
- **Recipient address / pubkey divergence** — `sendCore` now uses `resolved.eoa` (current chain state) for both `inbox.send` recipient and the encryption pubkey, instead of mixing the cached contact `r.addr` with the freshly-resolved `pubkey`. If a `.0g` name was transferred since the contact was cached, the message would have gone to the cached recipient with the new owner's pubkey, silently failing to decrypt.
- **`agent.contact_add` prefers canonical `.anima.0g` name** — when both `args.label` and resolver `r.name` are available, the canonical resolver name wins (it's portable + resolves back to the same address). Custom labels stay valid via `findByLabel` either way.

### Changed

- Single contact lookup per inbound message in `A2AListener.handleEvent` (was `has` + `find`).
- `sendCore` simplified from a 27-line three-branch dispatch to ~15 lines that go through `resolveAddrOrName` and a single resolver call for pubkey.

## [0.12.0] - 2026-04-29

### Added

- **Phase 7: A2A messaging.** `AnimaInbox` singleton (stateless event-emit contract) deployed on 0G mainnet at `0xcd92844cc0ec6Be0607B330D4BaCC707339f2589` (CREATE2, salt `keccak256("anima:AnimaInbox:v1")`, deploy tx `0xe8f1a32a4c713dd85edd56e38bac0ba1abffccbd8815d9199c0ef7759f957814`, block 31821581). Standard CREATE2 factory means the same address holds on testnet. 16KiB inline payload cap via `MAX_INLINE_PAYLOAD` defends against spam-to-brain (HIGH finding from 3-way audit). 25 forge tests, 100% line/branch/function coverage.
- **`@s0nderlabs/anima-plugin-comms`** — 11 brain limbs for ECIES-encrypted A2A messaging plus the AnimaInbox listener: `agent.message` (text), `agent.sendFile` (≤10MB, body to 0G Storage / metadata inline), `agent.fetchFile` (PathGuard-checked save, decrypts with own privkey), `agent.history` (sqlite), `agent.contact_add`/`contact_remove`/`contacts` (approve / list pending / blocked), `agent.block`, `agent.mute`/`unmute` (with optional `30m`/`1d` duration + `all` global), `agent.presence` (`online` ↔ `away`).
- **Filter chain in `A2AListener`** — blocked → resolveInbound (inline-vs-storage spillover) → ECIES decrypt → history insert (regardless of mute) → mute → presence (`away` buffers + bumps) → contact gate (non-contact records pending + emits one `pending-request` notice) → rate limit (10/60s for non-contacts) → onDeliver. Catch-up via paginated `getLogs` from cursor on first run; live `watchContractEvent` after. Cursor seeds from chain head on fresh boot to avoid scanning all of mainnet from genesis.
- **`derivePubkeyHex` (`@s0nderlabs/anima-core`)** — derives 65-byte uncompressed secp256k1 pubkey for ECIES recipients. Init wizard now writes the agent's pubkey as a `.0g` text record on `<label>.anima.0g` alongside `address` and `agent:inft`. Pre-Phase-7 agents are auto-published on next chat boot via `ensureOwnPubkeyPublished` (idempotent backfill). `test/local/backfill-pubkeys.ts` provides an explicit one-shot for batch recovery.
- **`PubkeyResolver`** — name → `.0g` text record lookup with 24h TTL cache. Errors clearly when a peer's pubkey record is missing (directs operator to `anima publish-pubkey`). Address + pubkey reads issued in parallel.
- **`config.subname` (`@s0nderlabs/anima-core`)** — recorded by init for the auto-publish path. `chat.tsx` reads it and fires `ensureOwnPubkeyPublished` fire-and-forget on every boot.
- **`PluginContext.comms` side-band field** — opaque `unknown` slot carries `CommsRuntimeContext` (viem clients, OGStorage adapter, SannClient, AnimaInbox singleton, listener delivery callbacks) into the plugin without forcing core to import plugin-comms types.
- **TUI: `inbox` row role** — distinct yellow `inbox  from 0xCCeC…d97a · "..."` row when an inbound A2A message arrives, replacing the misleading `you` indicator from the first cut. Inbound brain turns honor the existing `Esc` abort + per-turn auto-sync.
- **Inbound queue + drain** — single-flight `drainInbound` in `chat.tsx` queues live A2A events when the brain is mid-turn and processes them after each idle. Cap of 100 with eviction notice (`inbound queue full; dropped oldest from X`).
- **Brain prompt updates** — `frozen-prefix.ts` adds `agent.message` / `agent.sendFile` / `agent.history` to the "MUST use a tool" list and the comms tool-preferences block. Inbound channels arrive as `<channel source="anima.inbox" from="..." txHash="...">` blocks; brain treats them as untrusted external input.

### Live verification

- **specter (iNFT #4) ↔ fox (iNFT #5)** — full bidirectional A2A on 0G mainnet. Specter's `agent.message` (TX `0xe9b940fcbefbd20e494b62e06df08a2d242cbf9ed50563996c13594c1a6a5b28`) was decrypted by fox's listener, brain replied via `agent.message` with `in_reply_to` threading, specter received and rendered the response. Activity logs on both sides confirm `wake { source: 'a2a', from, txHash }` events. Self-loop on specter additionally validated the encrypt → emit → catch-up → decrypt → drain pipeline within a single agent.

### Security

- **Filter chain ordering**: blocked check fires BEFORE decrypt to avoid decrypt-oracle attacks.
- **`agent.fetchFile` PathGuard**: refuses writes under credential dirs (`~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/Library/Keychains`, the agent state tree).
- **Rate limiting**: non-contacts capped at 10 messages / 60s, dropping silently after that with one operator notice. Prevents bombardment of pending-contact requests.
- **Inbound queue cap**: bound at 100 messages with eviction. If the brain wedges and a torrent of A2A arrives, memory growth is bounded.

### Changed

- `MemorySyncManager.flushTurn` errors (e.g. transient 30s timeouts from a slow 0G storage node) now surface as a single `sys` row each turn; previous turn's sync error doesn't suppress the next turn's success.
- `Listener.start()` is fire-and-forget from the chat host; catch-up runs in the background instead of blocking the chat from accepting input on long-restored agents.
- Comms ctx is gated behind `pluginNames.includes('comms')` — non-comms launches skip the eager viem/storage/SannClient construction.

## [0.11.0] - 2026-04-29

### Added

- **`vision.analyze`** — describe / answer questions about an image. Routes to `qwen/qwen3-vl-30b-a3b-instruct` on 0G Compute mainnet via a lazy multi-provider broker pool. Accepts EITHER `image_path` (absolute path on disk) OR `image_url` (http/https). URL fetches stream and abort at the 10MB raw cap so a misleading URL pointing at a multi-GB asset cancels mid-download. Magic-byte MIME sniff covers PNG/JPEG/GIF/WebP/BMP. Verified live on mainnet: a "Hello Anima" placeholder PNG and a "Vision Live On 0G" image-URL, qwen3-vl returned accurate descriptions of both.
- **`browser.vision`** — capture the agent-browser tab's current page as a PNG screenshot and route it through the same vision provider. Replaces the v0.9.x stub with the real screenshot-then-analyze pipeline.
- **`BrokerPool` (`@s0nderlabs/anima-core`)** — caches one `@0glabs/0g-serving-broker` instance per provider address keyed off the agent's signer. Provider acknowledgement runs once per provider, lazily, on first use. Exposes `chatCompletion()` for OpenAI-compat dispatch and `visionInferFor(provider)` for the `image_url` content-block shape. Future-proof slot for whisper-large-v3 STT and z-image T2I when those serviceTypes need a chat-completion path.
- **`config.vision.provider`** — optional override for the multimodal provider. Defaults to `VISION_PROVIDER_DEFAULTS[network]` (qwen3-vl-30b on mainnet, none on testnet). Set to `null` to disable vision tooling on this agent.

### Security

- `vision.analyze` now runs `image_path` through the same `PathGuard` used by `fs.read` / `fs.write`. Without this, a brain could exfiltrate `~/.ssh/id_rsa` or any agent-state file by sending it as an "image" to qwen3-vl. Denies paths under `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/Library/Keychains`, and the agent state tree.

### Changed

- `web-fetch` exports `collectUpToBytes` so vision URL fetches can stream + abort at the maxBytes cap instead of buffering the whole body before the size check.

## [0.10.5] - 2026-04-28

### Fixed

- **`shell.cd` deny check ran AFTER realpath, breaking on CI runners.** v0.10.4 ordered the handler as `realpath → guard.check`, so a path like `~/.ssh/foo` on a runner where `~/.ssh` doesn't exist would ENOENT before the deny rule fired (the test asserted `protected path` in the error string and saw `stat failed: ENOENT` instead). Flipped to `guard.check(abs) → realpath → guard.check(canonical)` so denials happen at the string layer first, with a defense-in-depth re-check after canonicalisation. Local + CI-sim both green.

## [0.10.4] - 2026-04-28

### Added

- **`shell.cd <path>`** — set persistent cwd for subsequent `shell.run` / `code.execute` / `shell.process_start` calls. Saves repeating `cd X &&` prefixes on every command in multi-step coding workflows. Resolves relative paths against the current cwd; expands `~`; canonicalises through `realpath` so the stored cwd matches what `pwd` reports inside the sandbox. PathGuard refuses cd into credential dirs (`~/.ssh`, `~/.aws`, `.config/gcloud`) and the agent state tree. One shared `WorkingDirState` per session is wired across all four shell-class tools.
- **`web.fetch <url>`** — GET an http(s) URL, return body as markdown (HTML), pretty JSON (application/json), or plain text. Mirrors Claude Code's `WebFetch`: GET-only by construction, follows redirects, no auth headers (use `shell.run curl` for those). Bypasses the approval modal because the surface is read-only and refuses to talk to private/loopback/metadata IPs. Streams the body and cancels the reader once `max_bytes` (default 50KB) is reached, so a misleading URL pointing at a multi-GB asset doesn't pull the whole thing before truncation. Inline ~80 LOC HTML→markdown converter (no new deps).

### Fixed

- **PathGuard symlink bypass** — on macOS, `/var/folders/...` resolves to `/private/var/folders/...` via symlink. PathGuard previously stored only the as-given form of the agent state tree + credential dirs, so a brain that addressed the canonical form smuggled past the deny rule. Now stores BOTH the raw `resolve()` form and the realpath-canonical form, and check time tests both. Closes the hole for `fs.write` / `fs.patch` (which already used PathGuard) as well as `shell.cd`.

### Changed

- Brain prompt: added `shell.run` for directory listings (`ls`, `find`) and `web.fetch` for HTTP GET to the NEVER-from-memory list, so non-qwen models don't have to infer the routing. Added `shell.cd` and `web.fetch` to the Tool preferences section as well.

## [0.10.3] - 2026-04-28

### Fixed

- **Chat input bar clipped wrapped text.** The input box had `height={3}` (one content line between borders), so any prompt long enough to wrap silently lost the overflow rows. Switched to `minHeight={3}` + `maxHeight={12}` so the box grows with wrapped content (up to ~10 visible lines) and never starves the chat history on a paste of huge content.

### Changed

- **Scroll keybind now accepts Ctrl+U / Ctrl+D in addition to Opt+U / Opt+D.** Vim-style half-page scroll works in every terminal regardless of meta-key config; the existing Opt+U/D path stays for users whose terminal sends Opt as Alt (Ghostty needs `macos-option-as-alt = true`, iTerm2 "Option as Esc+", Terminal.app "Use Option as Meta key").

## [0.10.2] - 2026-04-28

### Fixed

- **DockerBackend container crash recovery was a false claim in v0.10.1.** The docstring promised "next wrapSpawn recreates the container" but the cached `containerId` survived external `podman kill` / OOM / daemon restart, so subsequent shell.run calls looped on `exit 125 — no such container` forever. Added `isContainerAlive` probe (`podman inspect --format '{{.State.Running}}'`, 3s timeout) in wrapSpawn that auto-invalidates the cache and re-runs `startContainer`. TTL-cached at 30s so happy-path spawns skip the ~30-70ms inspect tax. Verified live: external `podman kill` → next prompt spawns fresh container, brain resumes.

### Added

- **Hermes-style container resource caps.** Four new opt-in `sandbox.*` config fields: `dockerCpu` (`--cpus`), `dockerMemoryMb` (`--memory <N>m`), `dockerDiskMb` (`--storage-opt size=` — Linux+overlay2 only, no-op on macOS), `dockerNoNetwork` (`--network=none` for max paranoia). All unset by default — anima's stance is "let the container compete fairly with host work unless the operator opts in." Hermes recommended values documented in the annotated config template (`dockerCpu=1, dockerMemoryMb=5120, dockerDiskMb=51200`). Verified live via `podman inspect`: `Memory=2147483648`, `NanoCpus=1000000000` when `dockerCpu=1, dockerMemoryMb=2048` set.
- **Always-on container hardening.** Ported hermes-agent's `_SECURITY_ARGS`: `--init` (tini PID 1, reaps zombies), `--cap-drop ALL` + selective add of DAC_OVERRIDE/CHOWN/FOWNER (only what package managers need), `--security-opt no-new-privileges` (blocks setuid escalation), `--pids-limit 256` (caps fork bombs), size-limited tmpfs at /tmp (512MB), /var/tmp (256MB, noexec), /run (64MB, noexec). Applied to every spawned container regardless of operator config. Verified via `podman inspect` showing CapDrop/CapAdd/SecurityOpt/PidsLimit/Tmpfs/Init flags all set.
- **Linux bubblewrap backend (`LinuxBubblewrapBackend`).** Mode `'os'` on Linux now wraps spawns in `bwrap --ro-bind / / --bind agentDir/cwd/tmp --tmpfs <credential dirs> --proc /proc --dev /dev --unshare-all --share-net --die-with-parent --new-session -- ...`. Profile mirrors macOS seatbelt: deny by default, allow agentDir + cwd + /tmp writes, blackhole credential dirs (`~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.config/anthropic`, `~/.gnupg`) via empty tmpfs overlays. Falls back to LocalBackend with a clear stderr warning if `bwrap` isn't installed. Macs are unaffected; existing seatbelt path stays.
- **Sandbox awareness in the brain's frozen prefix.** New `SandboxEnvHint` exposed via `SandboxBackend.envHint()` and surfaced under `# Environment` in the system prompt. The brain now pre-knows mode/innerOs/workspaceMount/scope before its first turn, skipping the empirical-discovery dance (`pwd` + `ls /` + `uname` to figure out "am I in a container?"). Three friction points fixed at once: `fs.read('/workspace/X')` ENOENT loops, BSD-vs-GNU sed mismatch on first try, "where am I?" answered without tools. Verified live: brain answered with `toolCalls=0` when asked to describe environment, correctly identified docker container + Linux innerOs + workspace mount path.
- **Shared `CREDENTIAL_DIR_RELATIVE_PATHS` constant.** macOS seatbelt and Linux bubblewrap profiles now blackhole the same credential dirs from a single source. Earlier the bwrap profile included `~/.config/anthropic` + `~/.gnupg` while the seatbelt profile didn't — drift closed.

### Changed

- `wrapSpawn` in DockerBackend now consults a 30s TTL cache before issuing `podman inspect`. Happy path skips the probe entirely after the first successful call within the window. Container kill is detected on the next probe ≤30s after death.
- `chat.tsx` no longer assembles the brain's sandbox env hint via a 3-arm ternary; calls `sandbox.envHint?.() ?? null`. Backend-specific knowledge (e.g. "DockerBackend mounts at /workspace, MacOSSandboxExecBackend doesn't") moved into the backend that owns it.
- `EnvInfo` extracted as a named exported type from `@s0nderlabs/anima-core/brain`. Earlier it was duplicated verbatim between `BuildPrefixArgs` and `renderEnvInfo`'s parameter signature.

## [0.10.1] - 2026-04-28

### Added

- **Annotated sandbox config template at install time.** `~/.anima/config.ts` now ships with the active default (`mode: 'none'`) plus commented-out OPTION 2 (os) and OPTION 3 (docker) blocks pre-populated with security tradeoffs explained inline. Mirrors hermes-agent's `cli-config.yaml.example` pattern: documentation IS the UX, not an interactive wizard. Operator opts in by uncommenting + editing.
- **`ANIMA_SANDBOX_MODE` env var override.** Per-launch switch without editing the config file: `ANIMA_SANDBOX_MODE=docker anima --yolo`. Mirrors hermes' `TERMINAL_ENV` pattern. Valid values: `none`, `os`, `docker`. Wins over `sandbox.mode` in config.

### Fixed

- **DockerBackend: `code.execute` was broken in docker mode.** `code.execute` writes its snippet to a host tmpdir (via `mkdtemp(os.tmpdir() + '/anima-code-...')`) then spawns the interpreter against that path — but the container couldn't see `/var/folders/...` (macOS tmpdir) so every `code.execute` failed with "No such file or directory". DockerBackend now mounts the host's tmpdir READ-ONLY at the same path inside the container, so the snippet is readable. RO so `rm` from inside the container still fails with EROFS and host tmp stays write-isolated. Verified live: `code.execute` python returned `[0, 1, 1, 2, 3, 5, 8, 13]` from inside the container, host canary files still survived a destructive prompt under YOLO.

### Changed

- **Default container image switched to `nikolaik/python-nodejs:python3.11-nodejs20`.** Matches hermes-agent's `TERMINAL_DOCKER_IMAGE` default. Has bash + python3 + node + npm + git on standard PATH so every `code.execute` language and shell tool works out of the box. The previous `oven/bun:1` default (~250 MB) had python3 missing and node off-PATH; nikolaik (~700 MB) is bigger but works. Operators who only need bun/ts can override via `sandbox.dockerImage: 'oven/bun:1'`.

## [0.10.0] - 2026-04-28

### Added

- **Phase 9.5 sandbox: structural isolation for anima limbs.** Defense-in-depth layer beneath the existing permission floor (PathGuard + dangerous-pattern + strict/prompt/yolo modes). Even when the modal allow-session grants a destructive command, or YOLO disables the modal entirely, the OS sandbox or container blocks writes outside an allowlist. Two backends ship, opt-in via `sandbox.mode` in `~/.anima/config.ts`:
  - **`os` (Tier 2): macOS sandbox-exec wrapper.** Every shell.run / code.execute / shell.process_start spawn is wrapped in `sandbox-exec -p '<seatbelt-profile>' /bin/sh -c <cmd>`. Profile is deny-default with explicit allowlist for agentDir + cwd + `/tmp/anima-*` + `/var/folders`. Reads of `~/.ssh`, `~/.aws`, `~/Library/Keychains`, `~/.config/gcloud` are denied even though file-read is otherwise broad — blocks `cat ~/.ssh/id_rsa` exfiltration through shell.run. Empirically verified: `rm -rf /tmp/host-canary-X` returns "Operation not permitted", `rm -rf /tmp/tmux-501` (the Apr 28 incident path) is denied.
  - **`docker` (Tier 3): long-lived container per session.** Same isolation shape as hermes-agent's `TERMINAL_ENV=docker`. Auto-detects Docker Desktop OR Podman runtime (matching hermes' setup). Lazy-starts a single `oven/bun:1` container on first wrapSpawn (~1s cold, image auto-pulled if missing), reuses it via cached containerId for the rest of the session, kills it on SIGINT/SIGTERM via async dispose handler. Container has its own filesystem; host /tmp invisible to the agent unless `sandbox.dockerMountWorkspace: true` is set. Verified: brain issued `rm -rf /tmp/host-canary` under YOLO, command ran in container's /tmp (empty), host canary survived.
- **`SandboxBackend` interface + factory in `@s0nderlabs/anima-core`.** `LocalBackend` (passthrough, default), `MacOSSandboxExecBackend`, `DockerBackend`. `wrapSpawn` is async to support container lazy-start; sync backends use `Promise.resolve`. Optional `dispose()` for cleanup.
- **`anima.config.ts` sandbox knobs.** `sandbox.mode: 'none' | 'os' | 'docker'`, `sandbox.dockerImage` (default `oven/bun:1`), `sandbox.dockerMountWorkspace` (default `false`, honors hermes' isolation-by-default principle), `sandbox.dockerRuntimePath` (override auto-detect, e.g. force `/opt/homebrew/bin/podman`).
- **Sandbox startup banner.** When sandbox is active, anima prints to stderr at boot: `sandbox active [os:darwin]` or `container sandbox active [podman:oven/bun:1]` — operator can confirm isolation is on.

### Fixed

- **DockerBackend lazy-start race.** Concurrent first-callers used to each kick off `startContainer()` because `this.starting` was assigned only after `await`. Synchronous Promise assignment ensures all callers wait on the same start.
- **DockerBackend orphan on Ctrl-C.** Earlier draft used `process.once('SIGINT', () => { onExit(); process.exit(0) })` — `process.exit` runs synchronously, discarding the dispose Promise and leaving the container alive. Signal handlers now `await` dispose before exiting.

### Changed

- `shell.run`, `code.execute`, `shell.process_start` now route every spawn through the configured `SandboxBackend`. With `mode='none'` (default), behavior is byte-identical to v0.9.2 — backward-compatible.
- `PluginContext` extended with optional `sandbox: SandboxBackend`. Plugins receiving the context get the backend wired through automatically; legacy plugins that ignore it still work via the `LocalBackend` fallback.



### Added

- **Opt+U / Opt+D scrollback in the chat TUI.** The chat history's `<scrollbox>` is sticky-scroll-anchored to the bottom by default, which made it impossible to review past responses without leaving the input bar. Opt+U scrolls up 8 lines, Opt+D scrolls down 8 lines, and stickyScroll still snaps back to bottom when a new row arrives. Status footer now reads `opt+u/d scroll · ctrl+c exit` (or `esc interrupt · opt+u/d scroll · ctrl+c exit` while thinking). Wired through a ref to the underlying `ScrollBox.scrollBy`.
- **Esc-to-abort mid-turn.** Pressing Esc while the brain is mid-loop aborts the in-flight `brain.infer` via an `AbortController` plumbed through `fetch`. A `sys` row reports `turn interrupted (esc). brain stopped at the last completed step.` and the chat returns to idle. The next user prompt restarts on a fresh AbortController.
- **Concurrent-submit gate.** Pressing Enter on a non-empty input while the brain is already thinking now emits `turn in progress. press esc to interrupt before sending the next message.` instead of firing a second `brain.infer` (concurrent calls clobbered history before).

### Fixed

- **Chat TUI fails to boot when bun's cwd is outside the repo.** `bunfig.toml`'s `preload = ["@opentui/solid/preload"]` only fires when bun's cwd-walk discovers the file; running `cd ~ && bun /path/to/anima/packages/cli/bin/anima` (or invoking via an installed npm bin) skipped the preload entirely. Without the solid JSX transform plugin registered, JSX in `<ChatApp />` compiled to `React.createElement` (`Symbol(react.transitional.element)`) and opentui rejected it with a silent `maybeMakeRenderable received an invalid node` warning, leaving the alt-screen blank. Fix: `bin/anima` now imports `@opentui/solid/preload` directly. The plugin is idempotent, so bunfig.toml-discovered preloads remain a no-op when both fire.
- **CI typecheck failure when a unit test imports a `.tsx` module.** `markdown.test.ts` was importing the segment renderer from `markdown.tsx`, which dragged the JSX runtime into a unit test context. Bun's CI defaults to `react-jsx` and fails to resolve `react/jsx-dev-runtime` for the parser-only tests. Split into `markdown-parse.ts` (pure logic, no JSX) + `markdown.tsx` (the SolidJS component); the test now imports only from the `.ts` module.
- **Brain shadowed native `browser.*` tools with the `claude-code:agent-browser` skill.** Before any `tool.search` call, the brain saw `claude-code:agent-browser`'s rich SKILL.md description in the skill index and reached for that skill on web prompts. It then shelled out to qutebrowser-specific commands which always failed in anima's headless-Chromium harness. Frozen-prefix builder now filters `claude-code:agent-browser` (and its variants) out of the skill index, so the brain falls through to the native `browser.*` tools.

### Changed

- **Biome formatter pass on v0.9.1 changes.** `biome check --write .` ran clean on the post-v0.9.1 codebase. No behavior changes, only whitespace + import ordering.

## [0.9.1] - 2026-04-28

### Added

- **Browser parity with hermes (Task #74).** `packages/plugin-system/src/browser.ts` rewritten to mirror hermes' agent-browser harness. Per-process `a_<10hex>` session name + `--session <name>` flag (parallel chats no longer share a daemon). PATH walker that resolves `/opt/homebrew/bin`, every `/opt/homebrew/opt/node@N/bin`, repo-local `node_modules/.bin/agent-browser`, and `npx agent-browser` fallback (fixes "agent-browser CLI not found" on macOS systems with versioned-but-unlinked Homebrew nodes). Per-session `AGENT_BROWSER_SOCKET_DIR` under `/tmp` on darwin (sidesteps the macOS 104-byte AF_UNIX path limit that silently breaks screenshots). stdout/stderr write to temp files instead of pipes (eliminates the daemon-fd pipe deadlock that froze every prior browser call until timeout). Cleanup runs `agent-browser --session <sess> close` via `spawnSync` on `process.on('exit')` plus signal handlers, then rm-rf's the socket dir (no chrome zombies, no leaked sockets across runs). `ANIMA_BROWSER_CDP_URL` env var swaps `--session` for `--cdp <url>` when an operator wants to point at an external CDP endpoint (qutebrowser proxy, Browserbase, etc.). All 10 `browser.*` tools verified end-to-end against real headless Chromium + a 16-step form-fill drive on duckduckgo (typed query lands in results page, back returns to home). Hermes-grade resilience in 380 LOC; cloud provider abstraction + idle cleanup + vision impl deferred to post-MVP.
- **`coerceInt` zod helper.** Mirror of `coerceBool` for numeric tool args. qwen3.6-plus on the 0G broker stringifies numeric tool args (`pixels: "400"`); `z.number()` rejects with "Expected number, received string". `coerceInt` accepts native ints, "400"-style strings, leading/trailing whitespace; rejects floats, empty strings, and garbage. Applied to `browser.scroll.pixels`, `browser.get_images.limit`, `tool.search.max_results`, `delegate.task.max_output_tokens`, and `skills.view.max_bytes` (all numeric tool args anima exposes today). Same `ZodEffects` unwrap so the JSON Schema sent to the brain still shows `type: 'number'`.
- **`browser.get_images.limit` arg.** New tool param (0..200, default 50) exposed because the underlying implementation now extracts via `eval` instead of `agent-browser get attr` (which only returned the first match). Returns up to `limit` image src URLs as a JSON array string.
- **DDG form-fill integration smoke (`test/local/smoke-browser-form-fill.ts`).** 16-assertion live drive: navigate → snapshot → click → type query → press Enter → wait → snapshot results → assert results page contains query terms not present on the home page → scroll → snapshot → back → snapshot → assert query terms gone (back navigation actually moved off SERP). This is the integration test of record for the browser tool surface; the prior wrapper-only smoke checked dispatch, not side effects on a live page.
- **TUI markdown renderer (`packages/cli/src/ui/markdown.tsx`).** Assistant rows now parse `**bold**`, `*italic*`, `` `code` ``, `# headings`, `- bullet lists`, `1. numbered lists`, and triple-backtick fenced code blocks into styled opentui spans. The previous render dumped raw markdown syntax into the chat (asterisks and backticks visible as literal characters); now bold renders bold, code is highlighted in pink, headings are bold + amber, bullets render as `•`, and code fences strip the ``` markers and color the body. Custom (not opentui's `<markdown>`) so the existing fixed-width prefix gutter + indent pattern stays intact. 10 unit tests in `markdown.test.ts` cover the screenshot regression case (mixed bold + inline code + bullets).
- **Implicit settle wait after navigation actions.** `browser.navigate`, `browser.click`, `browser.type`, `browser.press`, and `browser.back` now run `agent-browser wait <ms>` after the primary command (1500ms for navigate/press/back, 1200 for click, 600 for type). Without this, qwen would issue `browser.snapshot` immediately after `browser.press(Enter)` and consistently get back the pre-submit page state; the brain blamed "snapshot caching" but the real issue was the wrapper not waiting for navigation. Verified on the live DDG drive: post-press snapshot now reflects the SERP, not the home page.

### Fixed

- **Round-trip cap removed from `OGComputeBrain`.** The hardcoded `MAX_ROUND_TRIPS = 5` truncated multi-step browser flows before the final content reply; with deferred tools the brain typically burns 1-2 rounds on `tool.search` lookups before it even reaches the actual workflow, so 5 was rarely enough. Replaced with `while (true)` that exits naturally when the model returns a content-only response (no `tool_calls`). The brain self-bounds via the prompt and the operator can still ctrl+c.
- **Auto-recovery from 0G broker safety reject.** qwen3.6-plus sometimes generates a tool name without the subname (e.g. bare `browser` instead of `browser.snapshot`); 0G's broker rejects that with "An error occurred while generating a tool call: Unauthorized: <name> is a blocked tool." and returns it as plain assistant content. anima now detects that string via `detectBlockedToolError`, injects a corrective user-style hint listing the valid dotted names (e.g. `browser.navigate, browser.snapshot, ...`), and continues the loop. Brain self-corrects on the next round-trip; operator no longer has to nudge it manually.
- **`browser.scroll` qwen string-int rejection.** `pixels="400"` was hitting `z.number().int().positive()` which rejected with "Expected number, received string". Fixed via `coerceInt` (see above). Reproduced live on mainnet specter, verified fixed on the same agent.
- **`browser.get_images` returning only the first match.** Previous impl shelled `agent-browser get attr src img` which only returns a single element. New impl uses `agent-browser eval` with a `document.querySelectorAll` extraction, returns up to `limit` URLs as a JSON array.
- **`agent-browser` daemon zombies on `bun ... && exit`.** Previous wrapper used `spawn` + `unref` to detach the cleanup, which fired AFTER the parent process exited; the detached `agent-browser close` IPC never connected, the daemon kept running, and chromium child processes accumulated until manual `pkill`. Replaced with `spawnSync` + 5s timeout in the exit handler so the close completes synchronously. Verified: zero chrome zombies after smoke + form-fill drive.
- **Stale `require('node:fs').closeSync` in browser wrapper.** Two file descriptors were closed via dynamic CJS `require` while the rest of the file used the imported `closeSync` directly. Inconsistent and would break ESM-only bundlers. Replaced both with the imported reference.

### Changed

- **"runtime" → "harness" in 11 user-facing strings.** Project terminology shift: anima is positioned as an agent harness (TS class names, `./runtime` package export, on-disk `runtimeState/` paths preserved for compat). Touched root + 2 workspace `package.json` descriptions, walletconnect dapp metadata (visible in MetaMask Mobile pairing UI), CLI banner, persona seed body (every new agent's `agent/persona.md` now reads "sovereign agent harness"), top-of-file `core/src/index.ts` comment, root `README.md` x2, and `CLAUDE.md` x3. Code identifiers (Runtime class, runtime/ folder name, `runtimeState` field) intentionally untouched pending operator confirmation.
- **`MAX_ROUND_TRIPS` removed.** See "Fixed" above. Each `Brain.infer` call now runs as many tool round-trips as the brain emits, until it produces a content-only response.

### Verification

- 217 unit tests pass (203 in 0.9.0 + 4 for `coerceInt` + 4 for `detectBlockedToolError` + 10 for the markdown parser; +14 net).
- 7 wrapper-level browser regression tests (`packages/plugin-system/src/browser.test.ts`).
- 24 wrapper-level integration assertions (`test/local/smoke-browser-parity.ts`): every tool runs against headless Chromium, AGENT_BROWSER_SOCKET_DIR honored, `--session` confirmed (no qutebrowser hijack).
- 16 form-fill integration assertions (`test/local/smoke-browser-form-fill.ts`): real DDG search on a query the home page never contains, results page contains all 4 query terms, back navigation removes them — proving the tools affect the live DOM, not just dispatch.
- Live tmux drive: brain dispatched `browser.navigate → browser.type → browser.press → browser.snapshot → browser.press → browser.snapshot → browser.click(@e58) → browser.snapshot` end-to-end on mainnet specter against duckduckgo with the unbounded round-trip loop.

## [0.9.0] - 2026-04-28

### Added

- **Skills system (Phase 9.1).** New `packages/core/src/skills/` module with SKILL.md frontmatter parser (name, description, version, license, metadata.filePattern, metadata.bashPattern, argument-hint), 4-path discovery (`~/.anima/skills/`, `~/.anima/plugins/<n>/skills/`, `~/.claude/skills/`, `~/.claude/plugins/cache/<m>/<p>/<v>/skills/`), and an auto-trigger hook in chat that emits a `↳ skill auto-loaded:` row when a tool call's path matches a skill's `filePattern` glob or its command matches a `bashPattern` regex. The skill index (id + description for each skill) is rendered into the cacheable system prefix so the brain knows what playbooks exist before any tool call. Scanner falls back to dir name + first body line when SKILL.md has no YAML frontmatter, so canonical skills like `tmux` (which have no frontmatter) are still discoverable. New `skills.manage` tool persists enable/disable state into `~/.anima/config.ts` under `skills.disabled[]`, with regex that handles both `defineConfig({})` and `export default {}` config shapes.
- **MCP stdio harness (Phase 9.2 Bundle 7).** New `packages/core/src/mcp/` module with a hand-rolled JSON-RPC stdio client, server discovery from `~/.anima/.mcp.json` + `~/.claude/.mcp.json` + every `~/.claude/plugins/cache/<m>/<p>/<v>/.mcp.json`, `${CLAUDE_PLUGIN_ROOT}` substitution, and an `McpManager` that spawns each stdio server in parallel at chat init, calls `initialize` + `tools/list`, and registers each remote tool as a deferred ToolDef under `mcp.<server>.<tool>`. Verified live: 4 of 6 configured servers (pragma, inb0x, string, nativ) registered 109 tools end-to-end on first boot; brain dispatched `mcp.pragma.get_all_balances` and surfaced a real Monad portfolio. HTTP servers (e.g. supabase) flagged as "not yet supported" pending Phase 9.4 polish.
- **Claude Code commands + agents discovery (Phase 9.2 Bundle 8).** New `packages/core/src/claude-plugins/` module parses every `commands/*.md` and `agents/*.md` from `~/.claude/plugins/cache/<m>/<p>/<v>/`. Commands surface as in-chat slash handlers; the brain inlines the body as a user message when invoked. Agents are addressable by short name through `delegate.task`. `/help` lists both built-in and inherited slash commands.
- **Four new LLM-using tools (Phase 9.3 Bundle 9).** `session.search` scans the agent's activity-log JSONL for substring or regex matches across wake events, tool calls, results, and brain responses. `delegate.task` spawns a fresh `OGComputeBrain` on the same provider with a custom system prompt (or the body of a Claude Code agent) and returns its single-turn reply, isolating focused work without polluting the parent context. `vision.analyze` returns a clear "vision-capable provider required" error until 0G ships a multimodal model. `code.execute` runs a snippet via bash/python3/node/bun with stdin pipe, configurable timeout (max 120s), and the same `redactEnv` floor as `shell.run`.
- **Ten browser tools wrapping `agent-browser` (Phase 9.4 Bundle 10).** `browser.navigate`, `browser.snapshot`, `browser.click`, `browser.type`, `browser.scroll`, `browser.back`, `browser.press`, `browser.get_images`, `browser.console`, `browser.vision`. All deferred-by-default (`shouldDefer: true`) so they only enter the brain prompt after `tool.search` matches them. `redactEnv` strips wallet keys before the spawned subprocess. Verified live driving a real headless Chromium to news.ycombinator.com and extracting the top story title, matching `curl` of HN exactly.
- **`shell.process` for long-running subprocesses (Phase 9.4 Bundle 11).** Single tool with action discriminator: `start` (returns id), `output` (read accumulated stdout/stderr, optional clear), `list` (all tracked), `kill` (signal). Map evicts exited entries on `output { clear: true }` and on `kill` of an already-exited proc to bound memory. `killAllProcesses` runs on chat exit so dev servers don't outlive the session.
- **`coerceBool` zod helper.** Tolerates `"true"`/`"false"`/`"1"`/`"0"`/`"yes"`/`"no"` strings + actual booleans + 0/1 numbers. Necessary because qwen3.6-plus serializes tool-call boolean args as JSON strings, which `z.boolean()` rejects. Applied to every boolean field in browser/session-search/shell-process schemas. `zodToJsonSchema` learned to unwrap `ZodEffects` so the JSON Schema sent to the brain still shows `type: 'boolean'`.
- **`ToolDef.parametersOverride`.** Optional JSON Schema override for tools whose param shape isn't expressed as a top-level `z.object()` (MCP tools whose remote schemas vary widely). When set, both `registry.schemas()` and `tool.search` skip `zodToJsonSchema` and use the override verbatim.
- **`PluginContext` extensions.** Every plugin's `register(ctx)` now receives `configPath`, `imports.claudeCode`, `skillsDisabled` mutable cell, `activityLogPath`, `workspaceRoot`, `delegateFactory`, `claudeAgents[]`, `brainSupportsVision`, `brainModelLabel`. `DelegateBrainFactory` / `DelegateBrainHandle` types exported from core.

### Fixed

- **Permission floor extended to `code.execute` and `shell.process`.** Both effectively run shell commands but bypassed `describePermissionCheck`. Now flow through the same strict / prompt / off resolver as `shell.run`. `PermissionRequest.kind` adds `'code.execute'` and `'shell.process'`. dangerous-pattern detection runs on `code.execute` snippets and `shell.process` start commands the same way it runs on `shell.run` invocations.
- **`OGComputeBrain` no longer sends an empty `tools: []` array.** 0G's broker (DashScope upstream) rejects with `"[] is too short - 'tools'"` HTTP 400, which broke `delegate.task`'s sub-brain whenever the parent passed no tools. The `tools` and `tool_choice` fields are now omitted entirely when the schema list is empty. Discovered live during the delegate.task drive on mainnet specter.
- **Scanner no longer drops skills without YAML frontmatter.** Previously `loadSkill` returned null when both `name` and `description` frontmatter fields were missing, which silently invisible-listed canonical skills like `tmux` (whose `SKILL.md` starts with `# tmux` directly). Scanner now falls back to the directory name + first non-empty non-heading body line. Regression test added.
- **`redactEnv` applied to every subprocess spawn.** `code.execute`, `shell.process`, and all 10 `browser.*` tools now strip wallet/API-key/keychain envs from the spawned process environment before exec. Brings them to parity with `shell.run`'s existing security floor (which the docstrings already claimed).
- **Memory file reads + skill scan run in parallel at chat boot.** Previously four sequential awaits (memory index, identity.md, persona.md, skill scan) added ~150-300ms to first-prompt latency on cold cache. Now `Promise.all` over all four.
- **`shell.process` Map leak.** Module-level `processes` Map never evicted exited entries (only cleared `proc` on `kill`), so a long session calling `start` 100 times accumulated up to 30MB of zombie buffers. Now evicted on `output { clear: true }` and on `kill` of an already-exited proc.

### Changed

- `OGComputeBrain.infer()` body construction split: `tools` + `tool_choice` only included when the schema list is non-empty, preventing broker 400s on empty-tool sub-brains.
- `agentIndex` Map removed from `chat.tsx` (was built but never read; `delegate.task` resolves agents off `claudeAgents[]` directly via plugin context).
- `delegate.ts` no longer redefines `DelegateBrainFactoryOpts` / `DelegateBrainHandle` / `DelegateBrainFactory`; imports them from `@s0nderlabs/anima-core`. Dead `parentPrefix` field dropped from `DelegateDeps`.
- `mcp/discovery.ts` no longer re-exports `dirname` from `node:path` (gratuitous re-export removed).

### Verification

- 192 unit tests pass (10 new across skills/, mcp/, claude-plugins/, tools/zod-helpers).
- typecheck clean, biome lint clean.
- Live tmux drive on mainnet specter (iNFT #4, qwen3.6-plus) confirmed all 28 native tools fire with `⏺ name(args)` + `⎿ ok/✗` indicators: `memory.save`, `memory.read`, `tool.search`, `fs.read`, `fs.write`, `fs.patch`, `fs.search`, `shell.run`, `shell.process` (all 4 actions), `code.execute` (python/bash/node/bun), `todo`, `clarify`, `skills.list`, `skills.view`, `skills.manage` (list/disable/enable + config persist), `session.search`, `delegate.task` (`agent:` and `system_prompt:` paths), `vision.analyze` (correct not-available error), `browser.*` (all 10), plus skill auto-trigger via `*.test.ts` filePattern and `mcp.pragma.get_all_balances` returning a real Monad portfolio. Real-website verified: anima drove headless Chromium to `https://news.ycombinator.com` and reported the actual top story title, matching `curl` exactly.

## [0.8.1] - 2026-04-27

### Fixed

- **WalletConnect operator can now mint, transfer, and fund.** `walletClient(network)` now creates the viem wallet client with `account: { address, type: 'json-rpc' }` instead of the prior `LocalAccount` returned from `toAccount({ ... })`. With a local account viem's `sendTransaction` first calls `account.signTransaction(tx)`, which under WC routes to `eth_signTransaction` over the relay. MetaMask Mobile does NOT support `eth_signTransaction` (only `eth_sendTransaction` / `eth_sendRawTransaction` per their JSON-RPC docs) and rejects with `-32004 Method not supported` before any popup ever shows. With a json-rpc account viem hits `eth_sendTransaction` directly: one MM popup, MM signs and broadcasts itself. Verified live on mainnet: WC operator successfully minted iNFT #5, executed `setApprovalForAll`, and funded the agent EOA in three sequential popups.
- **No more "stacked spinner" visual during init / sync / topup.** 0G Storage SDK and 0G Compute broker SDK both `console.log` directly during their work (selected nodes, tx hashes, "Detected mainnet", upload progress). When clack's spinner is running, every leaked log line pushes the spinner down and the next animation frame draws a new spinner row; on the WC mint test this rendered as ~100 stacked `◒/◐/◓/◑` rows. New `withSilencedConsole(fn)` helper in `packages/cli/src/util/silence-console.ts` mutes `console.log/info/warn/error/debug` for the scope of `fn` and restores afterward (even on throw). Wrapped at every noisy SDK call site: `mintAgent`, fund `sendTransaction`, `uploadAndAnchorKeystore`, `openComputeLedger`, subname registration, `OGComputeBrain.listServicesFor`, `fetchAndDecryptKeystore`, `MemorySyncManager.flushAll`, `getLedgerBalance`, `depositToLedger`. 4 unit tests cover mute/restore-on-success/restore-on-throw/return-value semantics.
- **Process exits cleanly after `anima init` / `topup` / `sync` / `inspect` / `status` / `model`.** Previously the WC relay websocket + 0G broker handles + 0G Storage indexer connections kept the event loop alive indefinitely, forcing the user to ctrl-C their shell after the wizard printed `Next: ...`. `packages/cli/src/index.ts` now `process.exit(0)` once `main()` resolves. `chat` uses its own internal exit path, so this also lands cleanly there.
- **Funding `sendTransaction` calls now use `getGasPriceWithFloor` instead of static `MIN_GAS_PRICE`.** `init.ts` operator-to-agent fund and `topup.ts --agent` were the two remaining sites still pinned to the 4 gwei fallback constant. They now read `eth_gasPrice` and clamp to floor, matching the pattern already used by `mint`, `setApprovalForAll`, `updateSlots`, and `claim`. Prevents min-fee rejections if the network floor moves above 4 gwei.
- **`mint.ts` reads `eth_gasPrice` once** (was twice: once for mint, once for setApprovalForAll, back-to-back). Single read covers both writes since the network floor cannot move meaningfully between them.
- **`anima restore` hard-aborts on operator/owner mismatch.** Previously printed a `note` and continued past the error, which kept the WC session alive long enough for tail relay events (`chainChanged` / `accountsChanged` for chains we never configured) to crash universal-provider with an uncaught `TypeError`. Now `cancel + operator.close + return` fires the moment the picked operator's address fails to match the iNFT owner.

### Added

- **WC regression test** at `packages/core/src/operator/walletconnect.test.ts` injects a mock provider, drives `walletClient.sendTransaction`, and asserts viem hits `eth_sendTransaction` (the mock throws if `eth_signTransaction` is invoked). Pins the json-rpc-account contract so anyone reverting the fix sees the test fail instead of paying real gas to discover the regression at mint time.

### Changed

- `getGasPriceWithFloor(client)` exported from `@s0nderlabs/anima-core` so call sites outside `core/identity` can read live gas with the same min-fee semantics.

## [0.8.0] - 2026-04-27

### Added

- **`anima inspect` — read what's anchored on chain for an iNFT.** New CLI command that reads slot hashes off the iNFT, fetches each encrypted blob from 0G Storage (with discovered-nodes RPC fallback), decrypts via the operator-derived memory key, and prints plaintext for every IntelligentData slot. The "audit your agent on chain" demo moment from session 12 now ships as a first-class command. Modes:
  - **default** — own agent: unlock keystore via operator wallet, decrypt all 6 slots (memory-index, identity, persona, profile, keystore-skipped, activity-log), render readable. Verified live on mainnet against iNFT #4: all 6 slots fetched, 5 decrypted (memory-index 613B, identity 415B, persona 125B, activity-log 100KB), profile correctly flagged empty, keystore correctly annotated as operator-encrypted.
  - **`--slot <name>`** — filter to a single slot.
  - **`--tx <hash>`** — decode a `Flow.update()` tx, show which slots were anchored at that tx, and which have been superseded by later txs.
  - **`--raw`** — skip operator unlock entirely; just dump root hashes + ciphertext sizes + 64-byte hex preview. For when you don't want to authenticate.
  - **`--diff`** — compare local memory files at `~/.anima/agents/<id>/memory/` (plus `activity.jsonl`) against decrypted chain plaintext via `keccak256` content hash. Status per slot: `in-sync`, `differ`, `local-only`, `chain-only`, `both-missing`, `cannot-decrypt`. Surfaces drift before transfers / after `git pull` / when something feels off. Live verified: 4/4 anchored slots returned `in-sync` against the active config.
  - **`--json`** — structured output for scripting; bigints stringified.
  - **`--full`** — print entire plaintext (default truncates each slot to 40 lines).
  - **`--out <dir>`** — dump every decrypted slot to `<dir>/<slot>.md` plus a `README.md` index. Lets the operator pull their full agent memory off chain to disk. Live verified: `--slot identity --out /tmp/dump` produced `identity.md` (415B) plus `README.md` summary.
  - **positional `<ref>`** — `0g-mainnet:0xCONTRACT:tokenId` or `eip155:<chain>:0xCONTRACT:tokenId` audits a foreign iNFT (raw view only since you don't hold the operator key).
- **`packages/core/src/identity/inspect.ts` library.** Pure read-only auditing API: `inspectAgent(opts)` (all-slots), `inspectSlot(opts)` (one-slot), `inspectTx(opts)` (tx decode + current-state diff), `diffAgent(opts)` (chain ↔ local hash diff). Result types `SlotInspection`, `TxInspection`, `SlotDiff` plus `DecryptStatus` discriminator (`ok | no-key | keystore-skipped | decrypt-failed | empty | fetch-failed`). Re-exported through `@s0nderlabs/anima-core` so any consumer can audit chain state without re-implementing the chain → storage → decrypt walk.
- **`downloadBlobViaDiscoveredNodes(indexerUrl, rootHash)` exported from `@s0nderlabs/anima-core/storage`.** Pulls the JSON-RPC fallback that powered `test/local/decode-onchain-memory.ts` into the public surface: `indexer_getShardedNodes` enumerates nodes, `zgs_getFileInfo(rootHash, false)` filters to finalized ones, `zgs_downloadSegmentByTxSeq(seq, 0, chunks)` fetches chunks, then concat + size-trim. Used as a fallback when the SDK indexer's `trusted` set is empty (mainnet has been returning `trusted: null` since Apr 2026).
- **`test/local/tmux-inspect.ts` driver** verifying 5 modes end-to-end in tmux: `--raw`, `--raw --slot identity`, `--slot bogus` (rejection), foreign-ref positional, `--json --slot identity` (output is parseable). Each invocation runs in its own tmux session because `runOneShot` resolves on the first `TEST_EXIT` marker; back-to-back calls in one session race against the previous run's marker.

### Changed

- **`downloadBlobByRoot` now falls through to discovered-nodes** when the SDK indexer path returns no blob. Any caller of `downloadBlobByRoot` (notably `fetchKeystore` → `anima restore`) automatically benefits: the indexer's degraded `trusted: null` state no longer stops a recovery cold.
- **CLI dispatch**: `anima inspect` registered next to `anima sync` / `anima restore`; help text lists the new command and its flag set.

## [0.7.1] - 2026-04-26

### Fixed

- **Chat TUI tool-call render crash**. The `Span` helper in `app.tsx` used `const Tag = 'span' as any; return <Tag fg=...>` — solid's JSX compiler bakes element names statically, dynamic `Tag` triggered `Comp is not a function`. The throw propagated synchronously through the reactive setter call → `state.pushRow` → out of `onToolCall` → out of `brain.infer`'s await → into `handleSubmit`'s catch, which then pushed an error sys row that re-triggered the same bug, dropping the row. Symptom looked exactly like a hung backend. Caught only after mirroring catch errors to `chat.log` via `console.error`. Fix: use `<span fg=…>` directly with `// @ts-expect-error` per call (runtime accepts; SpanProps omits `fg` in TS). Documented every workaround that fails (dynamic Tag, module-level alias, module augmentation, inline ANSI).
- **Multi-turn chat rows beyond turn 1 not reaching the renderer**. `app.tsx`'s `rowsWithPrev` `createMemo` produced fresh `{row, prev}` wrappers per state change, killing solid's identity-keyed `<For>` iteration. Replaced with direct `<For each={state.rows()}>` and a `firstOfBlock` flag computed once at push time in `state.pushRow`. Eliminates the O(N) reactive prev-walk per render too.
- **Slash commands (`/help`, `/yolo`, `/sync`, `/model`) left status stuck on `'thinking'`**, leaving the spinner spinning forever. `handleSubmit` now resets `status='idle'` on the slash early-return.
- **`og.ts:uploadViaDiscoveredNodes` translates `require(false)` reverts** when the agent EOA is too poor to land a `Flow.submit()`. After all 20 discovered storage nodes return the bare-revert, the catch reads `signer.getBalance()` + `provider.getFeeData()` in parallel and, if `balance < gasPrice * STORAGE_SUBMIT_GAS`, throws an actionable message: `0G Storage submit failed: agent EOA 0x… has only X 0G but needs ~Y 0G for gas. Top up: \`anima topup --agent 0.5\`.` Falls through to the original error otherwise. Caught when per-turn sync started failing mid-session after 75 successful submits — agent had drained to 262 µ0G, mainnet gas at 4 gwei, each submit needed ~1 m0G.

### Changed

- **Tool rows are first-class state shapes**, not stuffed into `'system'`. New `TurnRow.role` discriminants `'tool-call'` and `'tool-result'` with optional `toolName`, `args`, `failed` fields. TUI renders `⏺ tool.name(args)` (purple) and indented `⎿ result` (or red `✗ error`). Consecutive `assistant`/`tool-call`/`tool-result` rows from a single turn share the `anima` label via `firstOfBlock`.
- **Animated braille spinner** while status is `'thinking'`. `setInterval(80ms)` cycles `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` via a `spinnerFrame` signal, gated by a `createEffect` that only runs the timer when status is `'thinking'` (was burning 12.5 idle notifications/sec). Replaces the prior static-character hint.
- **Chat-error mirror to `chat.log`**. `handleSubmit` catch now `console.error`s the full stack alongside the in-chat sys row, so render-layer bugs that swallow the row before it reaches the screen still leave a post-mortem trail.
- **0G TS SDK upgrade 1.2.4 → 1.2.6**. API: `indexer.downloadToBlob(rootHash, false)` is now `indexer.downloadToBlob(rootHash, { proof: false })`. Updated both `downloadBlobByRoot` and `OGStorage.getBlob`.
- **Sync-error rows are not deduped**. An earlier prototype throttled identical sync errors to one per session; reverted — suppressing repeating errors is cheating, not signal hygiene. Repetition itself communicates "the upstream issue persists."

### Added

- **`STORAGE_SUBMIT_GAS = 250_000n`** exported from `packages/core/src/chain.ts` next to `MIN_GAS_PRICE`. Empirical gas budget for `Flow.submit()`; powers the balance-aware error and is available for future preflight checks.
- **`TurnRow.firstOfBlock`** computed at push time. Lets the renderer show speaker-block continuity without walking neighbors per render.

## [0.7.0] - 2026-04-26

### Added

- **Phase 9.0: plugin loader, deferred-tool surface, permission floor, and 9 P1 tools.** `@s0nderlabs/anima-plugin-system` now ships with `fs.read`, `fs.write`, `fs.patch`, `fs.search`, `shell.run`, `todo`, `clarify`, `skills.list`, `skills.view`. Loader path: `chat.tsx` → `loadPlugins(['system'], { resolve })` (the resolver is wired from the CLI package context so bun finds the workspace dep) → plugin's `register(ctx)` calls `ctx.registerTool` per tool. Tools become first-class brain capabilities with `▸ name(args)` / `↳ name ok` indicators in the TUI.
- **Deferred-tool semantics in `ToolRegistry`** mirroring Claude Code: `ToolDef` gains optional `alwaysLoad`, `shouldDefer`, `searchHint`. By default tools eager-load; `shouldDefer: true` hides the schema until `tool.search` matches it via `select:name` or free-text keywords, at which point `unlock(name)` makes it visible. Phase 9.0 ships eager only — the deferred path is wired and tested for Phase 9.4 browser tools.
- **`tool.search` meta-tool** (always-loaded). Brain calls it to hydrate deferred schemas: `select:fs.read,fs.write` for exact picks, free-text `"filesystem read"` for keyword search across name/description/searchHint.
- **`HookBus` + 10 lifecycle hook points** (`pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`, `pre_api_request`, `post_api_request`, `on_session_start`, `on_session_end`, `on_session_finalize`, `on_session_reset`). Phase 9.0 wires `pre_tool_call` (used by the permission gate to short-circuit destructive calls) and `post_tool_call` (audit observers). Other hook names exist as no-op stubs for future phases.
- **`PermissionService` (`packages/core/src/permission/`).** Three modes: `strict` (dangerous patterns hard-deny), `prompt` (default; dangerous OR shell.run consults the operator), `off` (YOLO, allow silently). Hermes's dangerous-command regex set ported (~36 patterns: `rm -rf`, `chmod 777`, fork bomb, `dd`, SQL `DROP`, `git reset --hard`, self-termination via pgrep, etc.). Patterns are pre-compiled case-insensitive at module load (was visible in profile when run per-call).
- **`PathGuard`**: `fs.read`, `fs.write`, `fs.patch`, `fs.search` refuse paths under `~/.ssh`, `~/.aws`, `~/.config/gcloud`, dotenv files anywhere, `/etc/`, `/boot/`, `/dev/`, `/sys/`, `/proc/`, and the agent's own state tree (`~/.anima/agents/<id>/`). Hard floor; YOLO does not bypass.
- **`redactEnv`**: `shell.run` strips wallet/api-key vars from `process.env` before spawning the subprocess. Catches `ANIMA_*_PRIVKEY*`, `*_PRIVKEY*`, `OPENAI_API_KEY`, `GH_TOKEN`, `AWS_*`, `STRIPE_SECRET_KEY`, etc. Removed names returned in the tool result so the brain can see what was stripped.
- **`--yolo` CLI flag and `/yolo` TUI slash.** `bun packages/cli/bin/anima --yolo` boots in YOLO mode (status bar shows `perms: off`); `/yolo` toggles between `prompt` and `off` mid-session. Approval modal renders in `app.tsx` with `[y] allow once  [s] allow session  [n] deny`; opentui keyboard handler intercepts y/s/n while a request is pending.
- **Approvals in `AnimaConfig`**: `approvals.mode: 'strict' | 'prompt' | 'off'` (default `prompt`) plus `approvals.allowlist: string[]`. Persisted in `~/.anima/config.ts`; the `--yolo` flag overrides for one session without rewriting the file.
- **`test/local/tmux-yolo.ts`** drives anima in YOLO mode interactively (status bar boot row + `/yolo` toggle), no brain credits burned. Joins the existing tmux driver suite as a regression gate for the permission system.
- **`test/local/e2e-phase9-plugins.ts`** integration script: plugin load, tool.search unlock semantics, PermissionService modes, fs.* path guard, shell.run env redaction, skills round-trip — all asserted at the dispatch layer with a temp workspace, no chain calls.
- **Plugin debug log**: when `ANIMA_DEBUG_PLUGINS=1` (or any plugin load error fires), chat writes `<agent-dir>/plugin-debug.log` with `pluginNames`, `loadResult`, and the registered tool list. Caught the v0.7.0 cycle's plugin-resolution bug (see Fixed below) when the brain reported "I only have 2 tools" and the log confirmed it.

### Fixed

- **Plugin dynamic import resolved from the wrong package context.** `loadPlugins` did `await import(\`@s0nderlabs/anima-plugin-${name}\`)` from inside `packages/core/src/plugins/context.ts`. The `core` package does not depend on `@s0nderlabs/anima-plugin-system` (that dep lives in `cli`), so bun's resolver returned `Cannot find module`, the plugin silently failed to load, and only `memory.save` / `memory.read` / `tool.search` were registered. The brain told the user "I only have those 2 tools" and was correct. Fix: `chat.tsx` now passes a `resolve` callback to `loadPlugins` so the dynamic import happens from the CLI package's scope where the workspace dep is resolvable. Caught only by an interactive tmux drive that observed the brain's actual reply — no automated layer below the chat surfaced it. Lesson saved as `feedback-tui-test-must-observe-brain.md` in the project memory.

### Changed

- **Tool naming convention locked to dotted namespace** (`fs.read`, `shell.run`, `memory.save`). Enables glob toggles in `config.tools` like `'fs.*': false` and avoids name collisions across plugins.
- **`/e2e full` Phase 4 walkthrough table** now includes "Plugin tool round-trip" and "Approval modal" rows that demand observed `▸ <tool>(...)` and `↳ <tool> ok/failed` indicators in the captured tmux pane. Status-bar smoke is no longer sufficient for chat-facing features.

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

[0.21.14]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.14
[0.21.13]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.13
[0.21.10]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.10
[0.21.9]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.9
[0.21.8]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.8
[0.21.7]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.7
[0.21.6]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.6
[0.21.5]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.5
[0.20.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.20.1
[0.20.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.20.0
[0.19.19]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.19
[0.19.18]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.18
[0.19.17]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.17
[0.19.16]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.16
[0.19.15]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.15
[0.19.14]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.14
[0.19.13]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.13
[0.19.12]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.12
[0.19.11]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.11
[0.19.10]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.10
[0.19.9]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.9
[0.19.4]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.4
[0.19.3]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.3
[0.19.2]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.2
[0.19.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.1
[0.19.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.19.0
[0.18.3]: https://github.com/s0nderlabs/anima/releases/tag/v0.18.3
[0.18.2]: https://github.com/s0nderlabs/anima/releases/tag/v0.18.2
[0.18.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.18.1
[0.18.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.18.0
[0.16.8]: https://github.com/s0nderlabs/anima/releases/tag/v0.16.8
[0.16.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.16.0
[0.15.6]: https://github.com/s0nderlabs/anima/releases/tag/v0.15.6
[0.15.5]: https://github.com/s0nderlabs/anima/releases/tag/v0.15.5
[0.15.4]: https://github.com/s0nderlabs/anima/releases/tag/v0.15.4
[0.15.3]: https://github.com/s0nderlabs/anima/releases/tag/v0.15.3
[0.15.2]: https://github.com/s0nderlabs/anima/releases/tag/v0.15.2
[0.15.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.15.1
[0.15.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.15.0
[0.14.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.14.1
[0.14.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.14.0
[0.13.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.13.0
[0.21.12]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.12
[0.21.11]: https://github.com/s0nderlabs/anima/releases/tag/v0.21.11
[0.12.2]: https://github.com/s0nderlabs/anima/releases/tag/v0.12.2
[0.12.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.12.1
[0.12.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.12.0
[0.11.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.11.0
[0.10.5]: https://github.com/s0nderlabs/anima/releases/tag/v0.10.5
[0.10.4]: https://github.com/s0nderlabs/anima/releases/tag/v0.10.4
[0.10.3]: https://github.com/s0nderlabs/anima/releases/tag/v0.10.3
[0.10.2]: https://github.com/s0nderlabs/anima/releases/tag/v0.10.2
[0.10.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.10.1
[0.10.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.10.0
[0.9.2]: https://github.com/s0nderlabs/anima/releases/tag/v0.9.2
[0.9.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.9.1
[0.9.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.9.0
[0.8.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.8.1
[0.8.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.8.0
[0.7.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.7.1
[0.7.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.7.0
[0.6.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.6.1
[0.6.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.6.0
[0.5.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.5.0
[0.4.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.4.0
[0.3.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.3.0
[0.2.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.2.1
[0.2.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.2.0
[0.1.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.1.0
