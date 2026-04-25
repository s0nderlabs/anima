/**
 * tmux driver for `anima logs`. Confirms the activity log command exits
 * cleanly. The activity log can be empty if the agent hasn't run yet, so
 * we only assert clean exit, not specific content.
 */
import { runOneShot, runTmuxTest } from './_tmux'

await runTmuxTest(`anima-logs-${process.pid}`, async s => {
  const { exit } = await runOneShot(s, 'bun packages/cli/bin/anima logs --tail 5', 30_000)
  if (exit !== 0) throw new Error(`logs exited with code ${exit}`)
  console.log('[ok] anima logs --tail 5 exited cleanly')
})
