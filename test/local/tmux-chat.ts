/**
 * tmux driver for `anima` (chat). Catches the regression class where the TUI
 * boots, renders one frame, and silently exits before the user can interact.
 *
 * Plain unit tests don't cover this — chat.tsx wires opentui's renderer +
 * stdin and clack/prompts spinner together, and a single mistake (e.g. a
 * spinner.stop() after createCliRenderer) tears down stdin. The only way to
 * catch that is to drive a real tmux pane: spawn anima, send a real message,
 * wait for a real brain response, and confirm the sync row points at a real
 * chain tx. Then exit cleanly via Ctrl+C and verify the process drained.
 */
import { capturePane, runTmuxTest, sendKeys, sleep, waitForText } from './_tmux'

const PROMPT = 'hello, are you there?'
const ASSISTANT_ROW = /^\s+anima\s/m
const SYNC_ROW = /synced .* → https:\/\//
const RESPONSE_TIMEOUT_MS = 60_000
const SYNC_TIMEOUT_MS = 90_000

await runTmuxTest(
  `anima-tmux-chat-${process.pid}`,
  async s => {
    await waitForText(s, /unlocked \(keystore source/, 30_000)
    console.log('[ok] keystore unlocked')

    // The "Connected" spinner row gets wiped when opentui takes the alt
    // screen, so we anchor on the TUI status bar that only renders after the
    // renderer mounts AND is still alive (the regression class kills it
    // mid-render so the bar never settles).
    await waitForText(s, /ctrl\+c exit/, 60_000)
    console.log('[ok] TUI rendered + alive')

    await sendKeys(s, `'${PROMPT}'`)
    await sleep(500)
    await sendKeys(s, 'Enter')
    console.log('[ok] message sent')

    await waitForText(s, ASSISTANT_ROW, RESPONSE_TIMEOUT_MS)
    console.log('[ok] brain replied')

    await waitForText(s, SYNC_ROW, SYNC_TIMEOUT_MS)
    const txMatch = capturePane(s).match(/0x[0-9a-f]{64}/i)
    if (!txMatch) throw new Error('sync row visible but no tx hash extractable')
    console.log(`[ok] per-turn sync anchored at ${txMatch[0]}`)

    await sendKeys(s, 'C-c')
    await sleep(2_000)
    console.log('[ok] sent ctrl+c')
  },
  'bun packages/cli/bin/anima',
)
