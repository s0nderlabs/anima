import { spawn } from 'node:child_process'
import { type ToolDef, redactEnv } from '@s0nderlabs/anima-core'
import { z } from 'zod'

interface ShellToolDeps {
  /** Working directory for spawned commands (typically agent workspace). */
  cwd: string
  /** Default timeout in ms. */
  defaultTimeoutMs?: number
}

const ShellSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe('Shell command to run. Quoted, fully formed (e.g., `ls -la`).'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(300_000)
    .optional()
    .describe('Override default 60s timeout.'),
})

export function makeShellRun(deps: ShellToolDeps): ToolDef<z.infer<typeof ShellSchema>> {
  return {
    name: 'shell.run',
    description:
      'Run a shell command in the agent workspace. Subject to permission approval (mode `prompt` or `strict`). Wallet/API-key environment variables are redacted before launch. Captures stdout/stderr; killed on timeout.',
    searchHint: 'shell run bash command execute subprocess',
    schema: ShellSchema,
    handler: async args => {
      const timeout = args.timeout_ms ?? deps.defaultTimeoutMs ?? 60_000
      const { env: redactedEnv, removed } = redactEnv(process.env)
      return new Promise(resolve => {
        const child = spawn(args.command, {
          cwd: deps.cwd,
          shell: true,
          env: redactedEnv,
        })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeout)
        child.stdout.on('data', chunk => {
          stdout += String(chunk)
          if (stdout.length > 200_000) stdout = stdout.slice(-200_000)
        })
        child.stderr.on('data', chunk => {
          stderr += String(chunk)
          if (stderr.length > 200_000) stderr = stderr.slice(-200_000)
        })
        child.on('close', code => {
          clearTimeout(timer)
          resolve({
            ok: !timedOut && code === 0,
            data: {
              command: args.command,
              code,
              timedOut,
              stdout: stdout.slice(-32_000),
              stderr: stderr.slice(-32_000),
              cwd: deps.cwd,
              redactedEnvVars: removed,
            },
            ...(timedOut
              ? { error: `command timed out after ${timeout}ms` }
              : code !== 0
                ? { error: `exit code ${code}` }
                : {}),
          })
        })
        child.on('error', e => {
          clearTimeout(timer)
          resolve({ ok: false, error: e.message })
        })
      })
    },
  }
}
