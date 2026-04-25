/**
 * tmux driver helpers for automated CLI testing.
 *
 * Each tmux-*.ts script uses these to drive a real `anima` session:
 *   import { tmuxSession, sendKeys, waitForText, capturePane, killSession } from './_tmux'
 *   const s = tmuxSession('anima-test-123', 'bun packages/cli/bin/anima init')
 *   try {
 *     await waitForText(s, 'Which 0G network', 5000)
 *     await sendKeys(s, 'Enter')
 *     ...
 *     await waitForText(s, 'Agent running', 120000)
 *     const pane = capturePane(s)
 *     assert(/iNFT #\d+/.test(pane))
 *   } finally {
 *     killSession(s)
 *   }
 *
 * Not a full framework. Keeps tmux drivers thin and readable.
 */
import { execSync } from 'node:child_process'

export type TmuxSession = { name: string }

export function tmuxSession(name: string, command: string): TmuxSession {
  execSync(`tmux new-session -d -s ${name} -x 200 -y 50 '${command.replace(/'/g, `'\\''`)}'`, {
    stdio: 'pipe',
  })
  return { name }
}

export async function sendKeys(session: TmuxSession, keys: string): Promise<void> {
  execSync(`tmux send-keys -t ${session.name} ${keys}`, { stdio: 'pipe' })
}

export function capturePane(session: TmuxSession): string {
  return execSync(`tmux capture-pane -t ${session.name} -p -S -`, { encoding: 'utf8' })
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export async function waitForText(
  session: TmuxSession,
  pattern: string | RegExp,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now()
  const regex = typeof pattern === 'string' ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : pattern
  while (Date.now() - start < timeoutMs) {
    if (regex.test(capturePane(session))) return
    await sleep(500)
  }
  throw new Error(
    `tmux: timeout waiting for ${regex} in session ${session.name} after ${timeoutMs}ms\n--- last pane ---\n${capturePane(session).slice(-2000)}`,
  )
}

export function killSession(session: TmuxSession): void {
  try {
    execSync(`tmux kill-session -t ${session.name}`, { stdio: 'pipe' })
  } catch {
    // already gone
  }
}

export function sessionAlive(session: TmuxSession): boolean {
  try {
    execSync(`tmux has-session -t ${session.name}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Spawn a tmux session, run `body`, kill the session no matter what, exit
 * non-zero on failure. Centralizes the try/catch/finally + double-kill
 * safety net every driver needs.
 */
export async function runTmuxTest(
  name: string,
  body: (session: TmuxSession) => Promise<void>,
  command = 'bash',
): Promise<void> {
  const session = tmuxSession(name, command)
  let exitCode = 0
  try {
    await body(session)
  } catch (e) {
    exitCode = 1
    console.error('[fail]', (e as Error).message)
  } finally {
    killSession(session)
  }
  if (exitCode !== 0) process.exit(exitCode)
}

/**
 * Run a one-shot bash command inside a session and return the pane plus
 * the command's exit code. Used by non-interactive CLI smoke drivers
 * (status, logs, sync, topup) where the binary prints output then exits.
 */
export async function runOneShot(
  session: TmuxSession,
  cmd: string,
  timeoutMs = 60_000,
): Promise<{ exit: number; pane: string }> {
  await sendKeys(session, `'${cmd.replace(/'/g, `'\\''`)}; echo TEST_EXIT=$?'`)
  await sendKeys(session, 'Enter')
  await waitForText(session, /TEST_EXIT=\d/, timeoutMs)
  const pane = capturePane(session)
  const m = pane.match(/TEST_EXIT=(\d+)/)
  return { exit: m ? Number(m[1]) : -1, pane }
}
