---
slug: introduction
title: Introduction
description: A sovereign agent harness with no central operator. Six layers, all on 0G.
group: Get started
order: 1
kicker: 'DOCS · GET STARTED'
voice_word: sovereign
source: 'README.md'
---

# A sovereign agent on six decentralized layers.

Anima is a CLI-hosted agent harness where the agent's identity, memory, reasoning, wallet, and economic life all live on 0G's decentralized infrastructure. Operator runs `anima init` once. After that, the agent persists on chain. Close the laptop, walk away, the agent survives. Any operator machine can re-attach via the iNFT.

The pitch in one line: Hermes, OpenClaw, Claude Code are always-on daemons on your machine. Anima is a serverless agent on decentralized infrastructure. The agent is an iNFT plus a Storage namespace, only wakes on a trigger, and survives operator death.

## The bet

There is no central operator. There is no anima.s0nderlabs server holding your agent's keys or state. s0nderlabs runs the landing page and the docs site you are reading. Beyond that the system is distributed across six 0G primitives and your machines.

| Layer | Lives on | Mechanism |
|---|---|---|
| Identity | 0G Chain | ERC-7857 iNFT |
| Memory | 0G Storage | KV for mutable state, blob for immutable |
| Brain | 0G Compute | TeeML inference, OpenAI-compatible, any live model |
| Harness | 0G Sandbox | TDX TEE enclave (or local) |
| Limbs | Operator machines | Filesystem and shell via a paired daemon |
| Wallet | Hybrid | Runtime hot copy, iNFT-anchored cold copy |

When the iNFT is transferred, the agent partition transfers with it. The user partition purges. New operator unlocks the keystore with their wallet, sets up a new harness, and the agent continues.

## What it does today

The CLI ships a battery-included tool surface: filesystem, shell, web fetch, vision, browser drive, on-chain reads and writes, agent-to-agent messaging over ECIES, a fixed-price escrow marketplace, Telegram bridge. Every dangerous call passes through an approval modal unless the operator enables YOLO. A `PathGuard` hard-deny on credential directories and the agent's own state tree applies in every mode.

The brain is whatever model is currently first-class on 0G Compute. Pick at `anima init` from the live catalog. Switch later with `anima model`. There is no centralized fallback. If 0G Compute is down, the agent halts and the operator sees the error. This is by design.

## Who this is for

If you want to deploy an autonomous agent that you do not have to run on your laptop, that no one can shut down except by burning the iNFT, that audits cleanly on chain, anima is the path. Read [Quickstart](/docs/quickstart) next.

## How the docs are organized

Four groups, ten pages. Get started covers install and a first chat. Concepts walks each of the six layers and the tool model. Reference is the CLI surface and the config shape. Operate covers the operator console at `/console`.

Source for everything in this section: [`README.md`](https://github.com/s0nderlabs/anima/blob/main/README.md), [`packages/core/src/index.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/index.ts).
