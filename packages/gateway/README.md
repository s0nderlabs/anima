# @s0nderlabs/anima-harness

Sandbox-resident harness daemon for **anima**. Runs inside the 0G Sandbox TDX TEE, exposes an HTTP control plane (`/chat`, `/events`, `/sync`, `/approval`), bootstraps a keypair, and accepts the agent privkey via Option 3 ECIES handoff from the laptop CLI.

## Install

```bash
bun add @s0nderlabs/anima-harness
```

Requires [bun](https://bun.sh) ≥ 1.1.

## Use

You don't run this directly on a laptop. It's bootstrapped automatically by `anima deploy` (Local→Sandbox migration) and `anima upgrade`. Documented for transparency; consumed by `@s0nderlabs/anima` (the CLI).

See the [root README](https://github.com/s0nderlabs/anima#readme) for the full sandbox architecture.
