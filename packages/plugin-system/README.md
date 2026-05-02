# @s0nderlabs/anima-plugin-system

System tools plugin for **anima**: `fs.read`, `fs.write`, `fs.patch`, `fs.search`, `shell.run`, `shell.cd`, `shell.process_*`, `code.execute`, `web.fetch`, 10 `browser.*` tools (via agent-browser CLI), `skills.list`, `skills.view`, `skills.manage`, `session.search`, `delegate.task`, `vision.analyze`, `tool.search`, `memory.read`, `memory.save`, `clarify`, `todo`.

Includes the multi-tier sandbox layer (macOS sandbox-exec, Linux bubblewrap, Docker) for safely executing untrusted shell + code.

## Install

Auto-installed when you `bun add -g @s0nderlabs/anima`. Or directly: `bun add @s0nderlabs/anima-plugin-system`.

Requires [bun](https://bun.sh) ≥ 1.1.

See the [root README](https://github.com/s0nderlabs/anima#readme) for the full tool surface and sandbox config.
