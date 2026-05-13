---
slug: memory
title: Memory
description: Two partitions, one index, end-to-end encryption. Memory is markdown, not a vector store.
group: Concepts
order: 5
kicker: 'DOCS · CONCEPTS'
voice_word: encrypted
source: 'packages/core/src/memory'
---

# Encrypted markdown, anchored on chain.

Anima's memory is a typed set of markdown files with YAML frontmatter, indexed by a single `MEMORY.md` file. No embeddings, no vector store. Plain text, encrypted, anchored on chain so it survives operator transfer.

## Two partitions

The directory layout under `~/.anima/agents/<id>/memory/`:

```
memory/
├── MEMORY.md
├── agent/
│   ├── identity.md
│   ├── persona.md
│   └── profile.md
├── user/
│   ├── feedback-*.md
│   ├── project-*.md
│   ├── reference-*.md
│   ├── learned-*.md
│   ├── convos-*.md
│   └── private-*.md
└── public/
```

`/agent/` is the agent's intrinsic memory. Identity, persona, learned facts about itself. When the iNFT transfers, this partition transfers.

`/user/` is operator-scoped memory. Feedback the operator has given, projects, references, conversations. Encrypted per operator. When the iNFT transfers, this partition purges. New operator starts clean.

`/public/` is not a memory partition. It is the profile-sync staging area for the `.anima.0g` subname text records (the CARD pattern). Owned by the naming layer, not the memory layer.

Source: [`packages/core/src/memory/types.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/memory/types.ts).

## Memory types

The frontmatter `metadata.type` determines the partition by default. The brain explicitly opts into `/agent/` writes (intrinsic) and defaults everything else to `/user/`.

| Type | Default partition | Use |
|---|---|---|
| `agent-identity` | agent | Facts about the agent: name, tokenId, operator history |
| `agent-persona` | agent | Voice, tone, personality |
| `agent-learned` | agent | Skills, conclusions, beliefs derived from experience |
| `user` | user | Anything tied to a specific operator |
| `user-convos` | user | Conversation excerpts worth keeping |
| `user-private` | user | Encrypted to that operator only |
| `feedback` | user | Operator corrections and validated approaches |
| `project` | user | Project context, milestones, deadlines |
| `reference` | user | Pointers to external systems |

Source: [`packages/core/src/memory/types.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/memory/types.ts).

## The index

`MEMORY.md` is the canonical entry-point. One line per topic file. Two hard caps: 200 lines and 25 KB. Past those, the file truncates on load. The index is frozen at session start for prompt-cache stability; only per-turn user-context injections update.

Format:

```markdown
- [Title](path/to/file.md) - one-line hook
```

The brain reads the index every turn (it lives in the frozen system prefix) and decides which topic files to read in full. The `memory.read` tool fetches a specific file. The `memory.save` tool writes one. Both run through the threat scan.

Source: [`packages/core/src/memory/index-file.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/memory/index-file.ts).

## Sync to 0G

A memory write goes to disk first, fast. The `MemorySyncManager` (class in `packages/core/src/memory/sync-manager.ts`, pipeline helpers in `packages/core/src/memory/sync.ts`) watches the partition. When a slot has changed (or `anima sync` is called), it:

1. Reads the changed file from disk.
2. Encrypts it with `deriveMemoryKey(agentPrivkey)` (HKDF from the agent's private key).
3. Uploads the ciphertext blob to 0G Storage Turbo indexer.
4. Batches the new root hash into a single `iNFT.update()` transaction covering every changed slot.

Per-turn writes do not anchor on chain. The CLI batches `/sync` operations. Specter (the team's mainnet test agent) anchors ~10 times per day under active use. The console's "last synced" indicator reports chain-anchor freshness, not conversation activity.

Source: [`packages/core/src/memory/sync.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/memory/sync.ts).

## Threat scan

Every memory write passes through `scanForThreats()` at `packages/core/src/memory/scan.ts`. Seven regex patterns block known prompt-injection and exfiltration vectors:

- `ignore previous instructions` and variants
- role override attempts ("you are now ...")
- system prompt extraction requests
- private key dump requests
- invisible Unicode control characters
- transfer/claim phrases that could fake operator authority
- exfiltration sinks: shell pipelines that POST or pipe to `curl`, `nc`, `wget`

If a write matches, the tool returns an error to the brain explaining which pattern matched. The write does not land. The brain decides whether to retry with sanitized content or abandon the save.

Source: [`packages/core/src/memory/scan.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/memory/scan.ts).

## The activity log

Slot 5 stores a rolling gzip-compressed sequence of recent turns. The blob format is `activity-log v=2` (gzip + JSONL inside). Anchored on chain so an auditor can replay the agent's tool calls. ~4.3x size reduction vs uncompressed; the change shipped in v0.21.14.

Source: [`packages/core/src/runtime/activity.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/runtime/activity.ts) (in-process JSONL append) plus [`packages/core/src/memory/activity-sync.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/memory/activity-sync.ts) (gzip-encrypt-upload).

## Frozen prefix

The brain's system prompt is built once per session at `packages/core/src/brain/frozen-prefix.ts`. It bundles the system prompt template, the memory index plaintext, identity, persona, the skill index, tool guidance, environment context, and a timestamp. Frozen means it does not change mid-session, so the prompt cache hits cleanly. Memory writes that happen during a session inject into the per-turn `userContextText` instead of mutating the frozen prefix.

Source: [`packages/core/src/brain/frozen-prefix.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/brain/frozen-prefix.ts).

Read [Brain](/docs/brain) next.
