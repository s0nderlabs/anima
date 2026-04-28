# Changelog

All notable changes to the anima monorepo are tracked per-package via [changesets](./.changeset/). Root-level entries live here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
