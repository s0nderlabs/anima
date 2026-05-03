// Tmux drive runner for plugin-telegram (manual-trigger).
//
// Why manual: agent-browser's `type --in <ref>` against TG WebK fails because
// the chat input uses contenteditable + React's controlled input state, not a
// standard textbox. execCommand insertText writes characters but the Send
// Message button's enabled-state stays gated. (See state-snapshot-2026-05-04
// in memory.) The cleanest live drive is operator-driven: anima runs in a tmux
// pane, operator DMs the bot from their TG client (phone or desktop), this
// runner watches for the expected response patterns + reports.
//
// Usage:
//   ANIMA_AGENT=specter ANIMA_TG_BOT_USERNAME=anima_specter_bot \
//     bun test/local/tmux-telegram-drive.ts
//
// Watches the activity.jsonl + the tmux pane output for ~5 min, reports which
// of these expected events fired:
//   - wake source=telegram
//   - tool-call shell.run / browser.navigate / memory.save
//   - brain-response source=telegram
//   - tg replying to chat <id>
//   - tg reply sent to chat <id>
//
// Exit 0 if at least one wake source=telegram + matching brain-response was
// observed within the deadline. Exit 1 on timeout.

import { spawn, execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AGENT = process.env.ANIMA_AGENT
const BOT_USERNAME = process.env.ANIMA_TG_BOT_USERNAME ?? `anima_${AGENT}_bot`
const DEADLINE_MS = Number(process.env.ANIMA_TG_DEADLINE_MS ?? 5 * 60_000)

if (!AGENT) {
  console.error('Set ANIMA_AGENT (e.g. ANIMA_AGENT=specter)')
  process.exit(1)
}

console.log(`tmux-telegram-drive: watching @${BOT_USERNAME} for agent=${AGENT}`)
console.log(`Operator: open https://t.me/${BOT_USERNAME} in your TG client and DM:`)
console.log(`  1. "what time is it"            (expects shell.run)`)
console.log(`  2. "remember i prefer dark mode" (expects memory.save)`)
console.log(`  3. "what's my agent EOA address" (expects chain.balance or fs.read)`)
console.log()
console.log(`Deadline: ${DEADLINE_MS / 1000}s.`)
console.log()

// Discover agent dir from the agent's iNFT-derived id. The runner reads the
// iNFT contract+tokenId from the local config and computes the same id the
// runtime uses.
const configPath = join(homedir(), '.anima', 'config.ts')
if (!existsSync(configPath)) {
  console.error(`Missing ${configPath}. Run anima init first.`)
  process.exit(1)
}

const configRaw = readFileSync(configPath, 'utf8')
const inftMatch = configRaw.match(/iNFT:\s*\{[^}]*contract:\s*['"](0x[a-fA-F0-9]+)['"][^}]*tokenId:\s*['"](\d+)['"]/)
if (!inftMatch) {
  console.error(`Could not parse iNFT from ${configPath}`)
  process.exit(1)
}
const [, contract, tokenId] = inftMatch

// Compute agentId via the same iNFTAgentId helper the runtime uses.
const { iNFTAgentId } = await import('@s0nderlabs/anima-core')
const agentId = iNFTAgentId({ contractAddress: contract as `0x${string}`, tokenId: BigInt(tokenId!) })
const activityLogPath = join(homedir(), '.anima', 'agents', agentId, 'activity.jsonl')

console.log(`Tailing activity log: ${activityLogPath}`)

const checks = {
  wake: false,
  brainResponse: false,
  toolCall: false,
  toolNames: new Set<string>(),
}

const tail = spawn('tail', ['-f', '-n', '0', activityLogPath])
tail.stdout.on('data', (chunk: Buffer) => {
  const lines = chunk.toString('utf8').split('\n').filter(Boolean)
  for (const line of lines) {
    let entry: { kind?: string; data?: { source?: string; call?: { name?: string } } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.kind === 'wake' && entry.data?.source === 'telegram') {
      checks.wake = true
      console.log(`✓ wake source=telegram observed`)
    }
    if (entry.kind === 'brain-response' && entry.data?.source === 'telegram') {
      checks.brainResponse = true
      console.log(`✓ brain-response source=telegram observed`)
    }
    if (entry.kind === 'tool-call') {
      const name = entry.data?.call?.name
      if (name) {
        checks.toolNames.add(name)
        if (!checks.toolCall) {
          checks.toolCall = true
          console.log(`✓ first tool-call observed: ${name}`)
        } else {
          console.log(`  · tool-call: ${name}`)
        }
      }
    }
  }
})

const deadline = Date.now() + DEADLINE_MS
const interval = setInterval(() => {
  if (checks.wake && checks.brainResponse && checks.toolCall) {
    clearInterval(interval)
    tail.kill()
    console.log()
    console.log(`✓ live drive PASSED — wake + brain-response + tool-call all observed`)
    console.log(`  tools called: ${[...checks.toolNames].join(', ')}`)
    process.exit(0)
  }
  if (Date.now() > deadline) {
    clearInterval(interval)
    tail.kill()
    console.log()
    console.error(`✗ live drive TIMEOUT after ${DEADLINE_MS / 1000}s`)
    console.error(`  wake: ${checks.wake}, brain-response: ${checks.brainResponse}, tool-call: ${checks.toolCall}`)
    console.error(`  tools called: ${[...checks.toolNames].join(', ') || '(none)'}`)
    process.exit(1)
  }
}, 1000)

process.on('SIGINT', () => {
  clearInterval(interval)
  tail.kill()
  process.exit(130)
})
