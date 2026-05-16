# @s0nderlabs/anima-core

Always-on infrastructure for **anima**: runtime, brain (0G Compute), identity (iNFT), memory (0G Storage), wallet, tool registry, event queue, plugin context.

## Install

```bash
bun add @s0nderlabs/anima-core
```

Requires [bun](https://bun.sh) ≥ 1.1.

## Use

You don't usually depend on `@s0nderlabs/anima-core` directly. Install [`@s0nderlabs/anima`](https://www.npmjs.com/package/@s0nderlabs/anima) (the CLI) which pulls everything in. This package exists for plugin authors and library consumers who want to embed the runtime.

See the [root README](https://github.com/s0nderlabs/anima#readme) for architecture and the full surface.
