/**
 * tmux driver for `anima inspect`. Each invocation runs in its own tmux
 * session — `runOneShot` resolves on the first `TEST_EXIT=N` it sees, so
 * back-to-back calls in one session race against the previous marker.
 *
 * Exercises every mode that doesn't require an interactive operator-wallet
 * password prompt (raw + foreign + slot filter + json + invalid-flag).
 * The decrypt-side modes (default + diff) live under /e2e human since
 * clack's `password()` step can't be safely scripted past.
 */
import { capturePane, killSession, runOneShot, sleep, tmuxSession, waitForText } from './_tmux'

const ANIMA = 'bun packages/cli/bin/anima'

type OneShot = { exit: number; pane: string }

async function oneShot(label: string, cmd: string, timeoutMs = 60_000): Promise<OneShot> {
  const name = `anima-inspect-${process.pid}-${label}-${Math.floor(Math.random() * 1e6)}`
  const session = tmuxSession(name, 'bash')
  try {
    // Wait for the bash prompt to appear before sending keys.
    await waitForText(session, /\$\s*$/, 5_000).catch(() => {})
    return await runOneShot(session, cmd, timeoutMs)
  } finally {
    killSession(session)
  }
}

async function main(): Promise<void> {
  // Mode A: --raw on active config. Lists slots with rootHashes + ciphertext sizes.
  // No operator unlock; just chain read + storage download.
  const raw = await oneShot('raw', `${ANIMA} inspect --raw`, 90_000)
  if (raw.exit !== 0) throw new Error(`inspect --raw exited ${raw.exit}\n${raw.pane.slice(-2000)}`)
  if (!/iNFT\s+#\d+/.test(raw.pane)) throw new Error('inspect --raw missing iNFT line')
  if (!/owner\s+0x[0-9a-fA-F]{40}/.test(raw.pane)) throw new Error('inspect --raw missing owner')
  if (!/────\s+memory-index/.test(raw.pane)) {
    throw new Error('inspect --raw did not list memory-index slot')
  }
  if (!/rootHash\s+0x[0-9a-fA-F]{64}/.test(raw.pane)) {
    throw new Error('inspect --raw missing rootHash output')
  }
  if (!/decrypt\s+skipped \(--raw\)/.test(raw.pane)) {
    throw new Error('inspect --raw should annotate decrypt as skipped')
  }
  console.log('[ok] inspect --raw — slots listed, decrypt skipped')

  // Mode B: --slot filter. Should print exactly one slot block.
  const slot = await oneShot('slot', `${ANIMA} inspect --raw --slot identity`, 30_000)
  if (slot.exit !== 0) {
    throw new Error(`inspect --raw --slot exited ${slot.exit}\n${slot.pane.slice(-2000)}`)
  }
  if (!/────\s+identity/.test(slot.pane)) throw new Error('inspect --slot identity missing')
  if (/────\s+memory-index/.test(slot.pane)) {
    throw new Error('inspect --slot identity should not include other slots')
  }
  console.log('[ok] inspect --raw --slot identity — single slot output')

  // Mode C: invalid slot rejected before doing any work.
  const badSlot = await oneShot('badslot', `${ANIMA} inspect --slot bogus`, 10_000)
  if (badSlot.exit === 0) throw new Error('inspect --slot bogus should fail')
  if (!/--slot must be one of/.test(badSlot.pane)) {
    throw new Error('inspect --slot bogus missing validation msg')
  }
  console.log('[ok] inspect --slot bogus — rejected with helpful error')

  // Mode D: foreign iNFT ref. Pull active iNFT from `anima status`, pass back
  // positionally. Should annotate as foreign and skip operator unlock.
  const status = await oneShot('status', `${ANIMA} status`, 15_000)
  if (status.exit !== 0) throw new Error(`status exited ${status.exit}`)
  const m = status.pane.match(/iNFT\s+#(\d+)\s+at\s+(0x[0-9a-fA-F]{40})\s+\((0g-(?:mainnet|testnet))\)/)
  if (!m) throw new Error(`could not parse iNFT from anima status\n${status.pane.slice(-1500)}`)
  const [, tokenId, contract, network] = m
  const ref = `${network}:${contract}:${tokenId}`
  const foreign = await oneShot('foreign', `${ANIMA} inspect ${ref}`, 90_000)
  if (foreign.exit !== 0) {
    throw new Error(`inspect ${ref} exited ${foreign.exit}\n${foreign.pane.slice(-2000)}`)
  }
  if (!/foreign — raw view only/.test(foreign.pane)) {
    throw new Error('inspect <ref> should annotate as foreign')
  }
  console.log(`[ok] inspect ${ref} — foreign view`)

  // Mode E: --json output is parseable.
  const j = await oneShot('json', `${ANIMA} inspect --raw --json --slot identity`, 30_000)
  if (j.exit !== 0) throw new Error(`inspect --json exited ${j.exit}\n${j.pane.slice(-2000)}`)
  const jsonStart = j.pane.indexOf('{\n')
  const jsonEnd = j.pane.lastIndexOf('}')
  if (jsonStart < 0 || jsonEnd < 0) {
    throw new Error(`inspect --json did not emit a json object\n${j.pane.slice(-1500)}`)
  }
  const jsonText = j.pane.slice(jsonStart, jsonEnd + 1)
  let parsed: { slots: Array<{ slot: string; rootHash: string }> }
  try {
    parsed = JSON.parse(jsonText)
  } catch (e) {
    throw new Error(
      `inspect --json output is not valid JSON: ${(e as Error).message}\nraw: ${jsonText.slice(0, 1000)}`,
    )
  }
  if (!Array.isArray(parsed.slots) || parsed.slots.length !== 1) {
    throw new Error(`inspect --json --slot identity should yield 1 slot, got ${parsed.slots?.length}`)
  }
  if (parsed.slots[0]!.slot !== 'identity') throw new Error('inspect --json slot mismatch')
  if (!/^0x[0-9a-fA-F]{64}$/.test(parsed.slots[0]!.rootHash)) {
    throw new Error('inspect --json rootHash malformed')
  }
  console.log('[ok] inspect --json — output parses, structure correct')

  console.log('\n[ok] anima inspect — 5 modes verified end-to-end')
}

await main().catch(e => {
  console.error('[fail]', (e as Error).message)
  process.exit(1)
})

// Tmux sessions are killed inline via finally; nothing to clean up here.
void sleep
void capturePane
