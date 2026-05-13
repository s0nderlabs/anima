---
slug: console
title: Console
description: A browser-side operator dashboard. SIWE, keystore unlock, encrypted memory browsing.
group: Operate
order: 10
kicker: 'DOCS · OPERATE'
voice_word: browser
source: 'apps/web/app/console'
---

# A browser-side operator dashboard.

The console at [anima.s0nderlabs.xyz/console](https://anima.s0nderlabs.xyz/console) is a multi-agent operator dashboard. Connect a wallet, sign in, see every iNFT you own, unlock its keystore, read the encrypted memory partition, audit the activity log, top up the wallet. Every decryption happens in the browser tab; no key material ever leaves your machine.

## The flow

1. **Connect wallet.** RainbowKit picks any EIP-1193 provider. The console's primary chain is 0G Mainnet (16661).
2. **Sign in with Ethereum.** EIP-4361 (SIWE) signature against a server-issued nonce. The server writes an `iron-session` cookie `{ address, chainId }`. No on-chain action; just proof of address ownership.
3. **List iNFTs.** The page scans `ERC-721 Transfer(0x0 -> you)` logs on `AnimaAgentNFT` and renders one row per token you currently own. Sync count and last-anchored timestamp come from `Updated` events.
4. **Pick an agent.** `/console/[tokenId]` opens the agent detail. Tabs for Identity, Memory, Activity, Wallet.
5. **Unlock keystore.** Click the unlock button on a tab that needs decryption. The page asks the operator wallet to sign an EIP-712 typed data payload. The signature derives a key via HKDF-SHA256. AES-256-GCM decrypts the keystore ciphertext fetched from 0G Storage. The agent private key and a derived memory key live in a React context for the rest of the session.
6. **Read memory.** The Memory tab fetches every slot blob via the `/api/blob/[rootHash]` proxy (avoids CORS), decrypts with the memory key, and renders the markdown with the same typography you are reading right now.
7. **Audit activity.** The Activity tab fetches the gzip activity-log blob, ungzips, parses the JSONL, and renders each turn with its tool calls and approvals.

The memory key never leaves the browser tab. The agent private key never leaves the browser tab. Refresh the page and you unlock again.

Source: [`apps/web/app/console`](https://github.com/s0nderlabs/anima/tree/main/apps/web/app/console).

## What you can do

**Identity.** See every IntelligentData slot, the root hash anchored on chain, the size, the contract address with a link to chainscan. Audit any iNFT (raw, no unlock needed) by typing a token id.

**Memory.** Left rail lists every file in `agent/` and `user/`. Click to render. The literary cream design renders the same markdown the brain reads, so the operator sees exactly what the agent sees.

**Activity.** Rolling log of recent turns. Each turn shows the brain's reply, the tool calls it issued, the approval decisions, the resulting state changes.

**Wallet.** Agent EOA balance on 0G Mainnet. (Top-up flows are CLI-only today; the console is read-only on the wallet tab.)

Source: [`apps/web/components/console`](https://github.com/s0nderlabs/anima/tree/main/apps/web/components/console).

## SIWE and sessions

`GET /api/auth/nonce` issues a random nonce. The wallet signs the EIP-4361 message that includes the nonce. `POST /api/auth/verify` checks the signature, validates the nonce hasn't been replayed, and writes the iron-session cookie. `GET /api/auth/me` returns the current session. `POST /api/auth/logout` clears it.

No server-held key material. The cookie is signed (HMAC) but contains only the address and chainId; the seal secret protects against forgery.

Source: [`apps/web/app/api/auth`](https://github.com/s0nderlabs/anima/tree/main/apps/web/app/api/auth).

## How the keystore unlock works

The encrypted keystore blob lives at the 0G Storage root anchored in slot 4 of the iNFT. The console fetches the blob via the `/api/blob/[rootHash]` proxy.

Decryption follows the same protocol as the CLI:

```
sig = operatorWallet.signTypedData(EIP712_DOMAIN, EIP712_TYPES, message)
key = HKDF-SHA256(sig, info='anima-keystore-aead-v1')
plaintext = AES-256-GCM.decrypt(blob.iv, blob.tag, blob.ct, key)
```

EIP-712 domain includes the iNFT contract address, the token id, and (for v0.6+ keystores) the chainId. The console tries with and without `chainId` for legacy keystore compat per `feedback-tokenid-to-agenteoa-via-updated-event` and v0.5 migration notes.

`agentPrivkey` and `memoryKey` are placed into a React context. The unlock component defensively calls wagmi's `useConnect({ connector })` when `useAccount.address` is null after a hard navigation, because kura and some wallets return `[]` from `eth_accounts` after a hard nav (`feedback-kura-no-persistent-auth-across-hard-nav`).

Source: [`apps/web/components/console/UnlockKeystore.tsx`](https://github.com/s0nderlabs/anima/blob/main/apps/web/components/console/UnlockKeystore.tsx).

## What is not in the console (yet)

- Send 0G or top up the compute ledger from the console. Use the CLI for now (`anima topup --compute N`).
- Trigger `anima sync` or `anima upgrade`. CLI only.
- Send a Telegram message as the agent. CLI or DM the bot.

The console is the audit and observability surface. The CLI is the command surface.

Read the [Quickstart](/docs/quickstart) or jump back to [Introduction](/docs/introduction) for the framing.

Source: [`apps/web/app/console`](https://github.com/s0nderlabs/anima/tree/main/apps/web/app/console).
