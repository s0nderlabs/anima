/**
 * tmux driver for the Phase 9.0 permission YOLO toggle.
 *
 * Drives the chat TUI in `--yolo` mode and asserts:
 *   1. boot status row mentions YOLO is on
 *   2. status bar shows perms: off
 *   3. /yolo slash flips back to prompt mode (status bar updates, system row appears)
 *
 * Does NOT send a brain message, so no 0G Compute credits are burned. The
 * regression class this catches is "operator launched with --yolo but the
 * service still gates" or "/yolo slash silently fails".
 */
import { capturePane, runTmuxTest, sendKeys, sleep, waitForText } from './_tmux'

await runTmuxTest(
  `anima-tmux-yolo-${process.pid}`,
  async s => {
    await waitForText(s, /unlocked \(keystore source/, 30_000)
    console.log('[ok] keystore unlocked')

    await waitForText(s, /perms: off/, 60_000)
    console.log('[ok] status bar shows perms: off')

    await waitForText(s, /YOLO mode/, 5_000)
    console.log('[ok] boot row mentions YOLO mode')

    await sendKeys(s, "'/yolo'")
    await sleep(300)
    await sendKeys(s, 'Enter')
    await waitForText(s, /YOLO OFF/, 10_000)
    console.log('[ok] /yolo slash flipped permissions back to prompt')

    await waitForText(s, /perms: prompt/, 5_000)
    console.log('[ok] status bar updated to perms: prompt after slash')

    await sendKeys(s, 'C-c')
    await sleep(2_000)
    console.log('[ok] sent ctrl+c, driver complete')
    capturePane(s) // exercise capture once more (no-throw)
  },
  'bun packages/cli/bin/anima --yolo',
)
