# Changelog

All notable changes to the anima monorepo are tracked per-package via [changesets](./.changeset/). Root-level entries live here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
