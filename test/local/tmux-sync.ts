/**
 * tmux driver for `anima sync` (force-flush memory + activity-log to 0G).
 *
 * Either it produces a chain anchor or it prints "nothing to sync" — both
 * are valid green paths. Operator unlock is silent via the macOS Keychain
 * hint already persisted in ~/.anima/config.ts.
 */
import { runOneShot, runTmuxTest } from './_tmux'

await runTmuxTest(`anima-sync-${process.pid}`, async s => {
  const { exit, pane } = await runOneShot(s, 'bun packages/cli/bin/anima sync', 180_000)
  if (exit !== 0) throw new Error(`sync exited with code ${exit}`)
  if (/anchored \d+ slot\(s\)|tx:\s*https:\/\/.*tx\/0x[0-9a-f]+/i.test(pane)) {
    console.log('[ok] anima sync — chain anchor created')
  } else if (/nothing to sync|already up to date/i.test(pane)) {
    console.log('[ok] anima sync — no changes (already in sync)')
  } else {
    throw new Error('sync exited 0 but neither anchor nor "nothing to sync" message visible')
  }
})
