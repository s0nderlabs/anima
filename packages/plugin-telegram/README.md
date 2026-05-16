# @s0nderlabs/anima-plugin-telegram

Telegram gateway for anima. Operator DMs `@anima_<name>_bot` from any phone; the agent (running in 0G Sandbox or local) replies.

## Highlights

- **Long-poll outbound only.** Works in both Local and Sandbox modes without inbound port exposure.
- **Allowlisted DMs.** Only configured `allowedUserIds` reach the brain.
- **Reactions as feedback.** 👀 on processing start, 👍 on success, 👎 on error.
- **Per-chat debounce.** 600ms quiet window collapses fragmented typing into one brain turn.
- **Rate-limited.** 30 messages / 60s per user via token bucket.
- **DM-only MVP.** Group / channel / forwarded messages dropped silently.
- **Sandboxed handoff.** Bot token never leaves the operator's encrypted blob; harness receives via ECIES envelope.

## Quickstart

```
anima telegram setup    # one-time interactive: bot token + allowed user IDs
anima                   # start the TUI; listener boots automatically
# DM @anima_<name>_bot from your phone, agent replies
```

## Architecture

The plugin registers one listener (`telegram-bot`) on the gateway. The listener:

1. Spins up a `grammy.Bot` with the operator's token in long-poll mode.
2. On inbound DM from an allowed user, reactions go to 👀, the message is buffered through the per-chat debounce, then dispatched to the brain via `ctx.telegram.dispatchUserMessage(input)`.
3. The brain runs a normal turn (refresh prefix, infer, tool calls, sync flush). Source label `'telegram'` flows into the prompt as `<channel source="telegram" chat="..." user="...">${text}</channel>`.
4. On turn end, the assistant text is sent back via `bot.api.sendMessage`. Reaction transitions to 👍 (success) or 👎 (error).

## Why grammy?

TS-first, lightweight (~30KB minified), bun-compatible. Telegraf and python-telegram-bot are reasonable alternatives but not TS-first.

## Out of scope (future)

- Webhook mode (long-poll covers MVP needs)
- Group chat support
- Bot API 9.4 DM Topics (per-A2A-peer topic isolation)
- Inline-keyboard exec approval (TG turns currently force `permission='off'`)
- Voice transcription / TTS
- DNS-over-HTTPS fallback IPs / proxy support
