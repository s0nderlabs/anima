/**
 * tmux driver for `anima topup --agent <amount>`. Verifies the operator
 * unlock + on-chain transfer to the agent EOA path. Sends a tiny amount
 * (0.001 0G) so the test cost is negligible across runs.
 */
import { runOneShot, runTmuxTest } from './_tmux'

await runTmuxTest(`anima-topup-${process.pid}`, async s => {
  const { exit, pane } = await runOneShot(
    s,
    'bun packages/cli/bin/anima topup --agent 0.001',
    120_000,
  )
  if (exit !== 0) throw new Error(`topup exited with code ${exit}`)
  if (!/0x[0-9a-f]{64}/i.test(pane) && !/sent 0\.001|done|tx:/i.test(pane)) {
    throw new Error('topup exited 0 but no tx hash visible')
  }
  console.log('[ok] anima topup --agent 0.001 completed')
})
