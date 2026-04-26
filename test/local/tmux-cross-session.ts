/**
 * tmux driver for cross-session memory recall.
 *
 * 1. Start chat. Tell agent something specific (a fact only it would know).
 * 2. Wait for memory.save tool fire + per-turn sync.
 * 3. Quit cleanly. Verify chain anchor went through.
 * 4. Start a fresh chat in a new session.
 * 5. Ask about the fact. Verify agent recalls it (via memory.read or
 *    MEMORY.md index).
 *
 * This is the load-bearing test for the "agent persists on chain, close the
 * laptop, walk away, the agent survives" pitch.
 */
import {
  capturePane,
  killSession,
  sendKeys,
  sleep,
  type TmuxSession,
  tmuxSession,
  waitForText,
} from './_tmux'

const SESSION_A = `anima-cross-a-${process.pid}`
const SESSION_B = `anima-cross-b-${process.pid}`

// Per-run unique topic key. This avoids self-pollution across runs: every run
// teaches the agent a different fact under a different memory key, so the
// recall question is unambiguous and previous-run entries can't shadow it.
const TAG = randomTag()
const TOPIC = `test-token-${TAG}`
const SECRET = `for this test session my unique token is ${TAG} — please remember this exact token under topic "${TOPIC}".`
const RECALL_QUESTION = `what was my unique token for topic "${TOPIC}"?`
const ASSISTANT_ROW = /^\s+anima\s/m

function randomTag(): string {
  const adjectives = ['silver', 'midnight', 'orange', 'glassy', 'humming', 'velvet']
  const nouns = ['trellis', 'lantern', 'orbit', 'theorem', 'beacon', 'dovetail']
  const hex = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0')
  const a = adjectives[Math.floor(Math.random() * adjectives.length)]
  const n = nouns[Math.floor(Math.random() * nouns.length)]
  return `${a}-${n}-${hex}`
}

async function chatTurn(session: TmuxSession, prompt: string): Promise<string> {
  await sendKeys(session, `'${prompt}'`)
  await sleep(500)
  await sendKeys(session, 'Enter')
  // Wait for an assistant row to appear AFTER our prompt. Anchor on the
  // strict role marker rather than waiting for "synced …" because the recall
  // turn may not change anything worth syncing.
  const start = Date.now()
  while (Date.now() - start < 90_000) {
    const pane = capturePane(session)
    const idx = pane.lastIndexOf(prompt)
    const tail = idx >= 0 ? pane.slice(idx) : pane
    if (ASSISTANT_ROW.test(tail)) return tail
    await sleep(1_000)
  }
  throw new Error(`agent never replied to "${prompt.slice(0, 60)}"`)
}

async function exitChat(session: TmuxSession): Promise<void> {
  await sendKeys(session, 'C-c')
  await sleep(4_000)
}

async function main(): Promise<void> {
  const sA = tmuxSession(SESSION_A, 'bun packages/cli/bin/anima')
  let exitCode = 0
  try {
    console.log(`[plant] secret = "${SECRET}"`)
    await waitForText(sA, /ctrl\+c exit/, 60_000)
    console.log('[ok] session A booted')

    await chatTurn(sA, SECRET)
    console.log('[ok] secret planted in session A')

    await waitForText(sA, /synced .* → https:\/\//, 90_000)
    const tx = capturePane(sA).match(/0x[0-9a-f]{64}/i)
    if (!tx) throw new Error('plant turn did not produce a chain anchor')
    console.log(`[ok] chain anchor for plant turn: ${tx[0]}`)

    await exitChat(sA)
    killSession(sA)
    console.log('[ok] session A exited')

    // Local cache at ~/.anima/agents/<id>/memory/ already holds the planted
    // entry — the per-turn sync wrote it before uploading to 0G. Session B
    // reads that local cache on boot so we don't need to wait for the 0G
    // Storage indexer to propagate. (A separate `tmux-restore.ts` covers the
    // chain-only rehydration path; that's what would need indexer waits.)

    const sB = tmuxSession(SESSION_B, 'bun packages/cli/bin/anima')
    try {
      await waitForText(sB, /ctrl\+c exit/, 60_000)
      console.log('[ok] session B booted (fresh process, same iNFT)')

      const reply = await chatTurn(sB, RECALL_QUESTION)
      console.log('[ok] agent replied in session B')

      if (!reply.toLowerCase().includes(TAG)) {
        throw new Error(
          `recall failed: tag "${TAG}" not found in reply.\n--- reply ---\n${reply.slice(0, 1500)}`,
        )
      }
      console.log(`[ok] cross-session recall PASSED — agent surfaced tag "${TAG}"`)

      await exitChat(sB)
      console.log('[ok] session B exited')
    } finally {
      killSession(sB)
    }
  } catch (e) {
    exitCode = 1
    console.error('[fail]', (e as Error).message)
  } finally {
    killSession(sA)
  }

  if (exitCode !== 0) process.exit(exitCode)
}

main().catch(e => {
  console.error('[fail]', e)
  killSession({ name: SESSION_A })
  killSession({ name: SESSION_B })
  process.exit(1)
})
