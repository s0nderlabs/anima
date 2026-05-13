---
slug: brain
title: Brain
description: 0G Compute via the serving-broker. TeeML attested inference. Fail loud, never fall back.
group: Concepts
order: 6
kicker: 'DOCS · CONCEPTS'
voice_word: attested
source: 'packages/core/src/brain'
---

# Attested inference inside a TEE.

The brain runs entirely on 0G Compute via the `@0glabs/0g-serving-broker` SDK. TeeML mode means every inference is signed by the provider's attestation key. If a request hits a tampered host, the broker's signature check fails and the call returns an error. There is no centralized fallback. Fail loud is the policy.

## The provider model

0G Compute hosts a catalog of OpenAI-compatible providers. Each provider runs one model in a TDX enclave. The catalog is live: `broker.inference.listService()` returns the current set with per-token pricing and the provider's EOA address. At `anima init` you pick from this catalog. The choice writes to `brain.provider` (provider EOA) and `brain.model` (model string) in `anima.config.ts`. Switch later with `anima model`.

The default flagship is whatever model 0G Compute features at the top. GLM-5 was first-class through Q1. Qwen3.6 took over. There is no hardcoded default in anima; the wizard pulls live every time.

Source: [`packages/core/src/brain/og-compute.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/brain/og-compute.ts).

## How a turn happens

`OGComputeBrain.infer({ event, history })` (`packages/core/src/brain/og-compute.ts`) builds the request:

1. Compose the frozen prefix (system prompt + memory index + identity + persona + skill index + tool list + env).
2. Append the conversation history.
3. Append the current event as a user message.
4. Estimate token count. If above `compaction.threshold * contextWindow` (default 0.5 * 1,000,000), fold older turns via a separate compaction call before the main inference.
5. Call `broker.inference.getRequestHeaders(providerAddress, messageText)` to get attested headers.
6. POST to `${endpoint}/chat/completions` with the OpenAI-compatible payload plus the attested headers.
7. Parse the response. If `tool_calls` are present, dispatch each one through the tool registry and feed results back. Repeat until the model emits no more tool calls.
8. Return the final `turn` to `routeLoop`.

Default `max_tokens` is 4096 (`DEFAULT_MAX_OUTPUT_TOKENS` in `og-compute.ts`). The default context window is 1,000,000. Both are configurable under `brain` in `anima.config.ts`.

## The ledger

The serving-broker maintains a per-agent ledger that prepays for inference. `broker.ledger.addLedger` opens it (at init), `broker.ledger.depositFund` tops up, `broker.ledger.refund` pulls funds back. Each provider has a sub-account; tokens get locked when you transact with that provider for the first time. The locks have a refund window per provider; `anima ledger retrieve` starts the window, and a second call after the window completes the refund.

`anima balance` shows the full position in one read-only call: main ledger total, per-provider available, per-provider locked, plus EOA balance and sandbox billing reserve. Use this before topping up so you know what is already locked versus available.

Source: [`packages/core/src/brain/ledger.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/brain/ledger.ts), [`packages/cli/src/commands/balance.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/cli/src/commands/balance.ts).

## Auto-topup

`AutoTopupManager` (`packages/core/src/economy/auto-topup.ts`) is opt-in via `economy.autoTopup` in config. When enabled, the manager polls every 5 minutes. If a per-provider locked envelope drops below the threshold, it auto-deposits more from the agent EOA, capped by a configured ceiling.

A 10-minute cooldown was added in v0.21.14 to kill the "insufficient wallet" spam loop that happened when the agent EOA ran dry mid-poll. Operator can override the polling interval via config.

Source: [`packages/core/src/economy/auto-topup.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/economy/auto-topup.ts).

## Vision

The `vision.analyze` tool routes screenshots and image files through a separate broker pool. The mainnet vision provider lives at `0x4415ef5CBb415347bb18493af7cE01f225Fc0868` running `qwen/qwen3-vl-30b-a3b-instruct`. Same TeeML attestation. Same ledger model.

`browser.vision` is a convenience: screenshot the active agent-browser tab plus route through the same provider in one tool call.

Source: [`packages/core/src/brain/broker-pool.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/brain/broker-pool.ts).

## Compaction

When estimated token count breaches `compaction.threshold * contextWindow`, the brain folds the oldest portion of conversation history into a summary. The summary is generated via a separate broker call with `SUMMARY_SYSTEM_PROMPT` and `max_tokens: 1024`. Older turns are replaced by the summary in subsequent inferences. The frozen prefix never compacts.

Source: [`packages/core/src/brain/og-compute.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/brain/og-compute.ts).

## Fail loud

There is no fallback to OpenAI or Anthropic. There is no key-storage layer for non-0G providers. If 0G Compute is degraded, the agent halts and the operator sees the error. The brain queue persists, so when 0G recovers the queued events resume.

Post-MVP, a user-local relay limb is on the roadmap: the user runs `anima-limb` paired to their agent, the limb holds the external API key locally, and the agent calls a `delegate.task` tool whose execution is the limb proxying to OpenAI. Keys stay on the user's machine. That is the only acceptable escape hatch given the sovereignty thesis.

Read [Tools](/docs/tools) next.

Source: [`packages/core/src/brain/og-compute.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/brain/og-compute.ts), [`packages/core/src/brain/ledger.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/brain/ledger.ts).
