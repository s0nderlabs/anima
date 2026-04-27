import { type ChildProcess, spawn } from 'node:child_process'
import { type ToolDef, coerceBool, redactEnv } from '@s0nderlabs/anima-core'
import { z } from 'zod'

/**
 * `shell.process`: long-running background subprocess with a handle id.
 *
 * The brain calls `shell.process { action: 'start', command: 'bun dev' }` to
 * spin up a server, then `shell.process { action: 'output', id }` to read
 * accumulated stdout/stderr, and `shell.process { action: 'kill', id }` to
 * tear it down. State lives in module-level memory; the process tree is
 * killed when anima exits.
 *
 * This is distinct from `shell.run`: shell.run waits for completion (good for
 * one-shot commands), shell.process backgrounds it (good for dev servers,
 * watchers, REPLs).
 */

interface BackgroundProcess {
  id: string
  command: string
  cwd: string
  proc: ChildProcess
  stdout: string
  stderr: string
  startedAt: number
  exitCode: number | null
  exitedAt: number | null
}

const processes = new Map<string, BackgroundProcess>()

const ProcessSchema = z.object({
  action: z
    .enum(['start', 'output', 'list', 'kill'])
    .describe(
      "'start' (returns id; requires command), 'output' (requires id), 'list' (no other args), 'kill' (requires id)",
    ),
  command: z
    .string()
    .min(1)
    .optional()
    .describe('For action=start: command to run via /bin/sh -c.'),
  cwd: z.string().optional().describe('For action=start: working directory override.'),
  id: z.string().min(1).optional().describe('For action=output|kill: id from a previous start.'),
  clear: coerceBool
    .optional()
    .describe('For action=output: clear the captured output after returning.'),
  signal: z
    .enum(['SIGTERM', 'SIGKILL', 'SIGINT'])
    .optional()
    .describe('For action=kill: signal to send. Default SIGTERM.'),
})

interface ShellProcessDeps {
  cwd: string
}

export function makeShellProcess(deps: ShellProcessDeps): ToolDef<z.infer<typeof ProcessSchema>> {
  return {
    name: 'shell.process',
    description:
      "Manage long-running background subprocesses. Actions: 'start' (returns id), 'output' (captures stdout/stderr), 'list' (all active), 'kill' (terminate by id). Use shell.run for one-shot commands instead.",
    searchHint: 'shell process background subprocess long running daemon',
    schema: ProcessSchema,
    handler: async args => {
      switch (args.action) {
        case 'start':
          if (!args.command) return { ok: false, error: 'command is required for action=start' }
          return startProcess(args.command, args.cwd ?? deps.cwd)
        case 'output':
          if (!args.id) return { ok: false, error: 'id is required for action=output' }
          return captureOutput(args.id, args.clear ?? false)
        case 'list':
          return listProcesses()
        case 'kill':
          if (!args.id) return { ok: false, error: 'id is required for action=kill' }
          return killProcess(args.id, args.signal ?? 'SIGTERM')
      }
    },
  }
}

function startProcess(
  command: string,
  cwd: string,
): { ok: boolean; data?: { id: string }; error?: string } {
  const id = `proc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { env } = redactEnv(process.env as Record<string, string>)
  const proc = spawn('/bin/sh', ['-c', command], { cwd, env })
  const entry: BackgroundProcess = {
    id,
    command,
    cwd,
    proc,
    stdout: '',
    stderr: '',
    startedAt: Date.now(),
    exitCode: null,
    exitedAt: null,
  }
  processes.set(id, entry)
  proc.stdout?.setEncoding('utf8')
  proc.stderr?.setEncoding('utf8')
  proc.stdout?.on('data', chunk => {
    entry.stdout += chunk as string
    if (entry.stdout.length > 200_000) entry.stdout = entry.stdout.slice(-200_000)
  })
  proc.stderr?.on('data', chunk => {
    entry.stderr += chunk as string
    if (entry.stderr.length > 100_000) entry.stderr = entry.stderr.slice(-100_000)
  })
  proc.on('exit', code => {
    entry.exitCode = code
    entry.exitedAt = Date.now()
  })
  return { ok: true, data: { id } }
}

function captureOutput(
  id: string,
  clear: boolean,
): {
  ok: boolean
  data?: {
    id: string
    stdout: string
    stderr: string
    exit_code: number | null
    running: boolean
    started_at: number
    exited_at: number | null
  }
  error?: string
} {
  const entry = processes.get(id)
  if (!entry) return { ok: false, error: `unknown process: ${id}` }
  const out = {
    id,
    stdout: entry.stdout,
    stderr: entry.stderr,
    exit_code: entry.exitCode,
    running: entry.exitCode === null,
    started_at: entry.startedAt,
    exited_at: entry.exitedAt,
  }
  if (clear) {
    entry.stdout = ''
    entry.stderr = ''
  }
  // After the brain reads output for an exited process, evict it so
  // long-running sessions don't accumulate dead entries with multi-MB buffers.
  if (entry.exitCode !== null && clear) {
    processes.delete(id)
  }
  return { ok: true, data: out }
}

function listProcesses(): {
  ok: boolean
  data: {
    processes: Array<{
      id: string
      command: string
      cwd: string
      running: boolean
      exit_code: number | null
      started_at: number
    }>
  }
} {
  return {
    ok: true,
    data: {
      processes: [...processes.values()].map(p => ({
        id: p.id,
        command: p.command,
        cwd: p.cwd,
        running: p.exitCode === null,
        exit_code: p.exitCode,
        started_at: p.startedAt,
      })),
    },
  }
}

function killProcess(
  id: string,
  signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT',
): { ok: boolean; data?: { id: string; killed: boolean }; error?: string } {
  const entry = processes.get(id)
  if (!entry) return { ok: false, error: `unknown process: ${id}` }
  if (entry.exitCode !== null) {
    processes.delete(id)
    return { ok: true, data: { id, killed: false } }
  }
  try {
    entry.proc.kill(signal)
    return { ok: true, data: { id, killed: true } }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Kill all tracked processes. Called by chat.tsx on session exit. */
export function killAllProcesses(): void {
  for (const entry of processes.values()) {
    if (entry.exitCode !== null) continue
    try {
      entry.proc.kill('SIGTERM')
    } catch {}
  }
}
