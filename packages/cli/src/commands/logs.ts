import { readFile } from 'node:fs/promises'
import {
  SANDBOX_PROVIDER_URL_GALILEO,
  SandboxProviderClient,
  agentPaths,
} from '@s0nderlabs/anima-core'
import { findAndLoadConfig } from '../config/load'
import { pickDefaultAgent } from './_agents'
import { loadOrPickOperatorSigner } from './init/operator-picker'
import { extractExecOutput } from './init/sandbox-provision'

export async function runLogs(opts: { agent?: string; tail?: number } = {}): Promise<void> {
  // Phase 11: in sandbox mode the activity log lives in the container at
  // /var/log/anima-gateway.log. Tail it via toolbox exec.
  const found = await findAndLoadConfig().catch(() => null)
  if (
    found?.config.deployTarget === 'sandbox' &&
    found.config.sandbox?.id &&
    found.config.sandbox.endpoint
  ) {
    const operator = await loadOrPickOperatorSigner({
      network: found.config.network,
      hint: found.config.operator,
    })
    if (!operator) {
      console.log('No operator wallet available; cannot authenticate to provider.')
      process.exit(1)
    }
    const operatorAccount = await operator.account()
    const provider = new SandboxProviderClient({
      endpoint: SANDBOX_PROVIDER_URL_GALILEO,
      operator: operatorAccount,
    })
    const tail = opts.tail ?? 200
    try {
      const r = await provider.execInToolbox(found.config.sandbox.id, {
        // Harness logs to ~/anima-logs/ inside the container (daytona user;
        // /var/log needs root). bash -c needed because Daytona exec splits
        // argv-style without a shell.
        command: `bash -c 'tail -n ${tail} ~/anima-logs/anima-gateway.log'`,
        timeout: 60,
      })
      const out = extractExecOutput(r)
      if (out) process.stdout.write(out)
      if (r.exitCode !== 0) {
        process.stderr.write(`\n(toolbox exit=${r.exitCode})\n`)
      }
    } catch (e) {
      console.log(`harness log fetch failed: ${(e as Error).message.slice(0, 200)}`)
    }
    await operator.close?.()
    return
  }

  // Local mode: read from agentPaths
  const id = opts.agent ?? (await pickDefaultAgent())
  if (!id) {
    console.log('No agents found in ~/.anima/agents. Run `anima init` first.')
    process.exit(1)
  }
  const path = agentPaths.agent(id).activityLog

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`No activity log at ${path}`)
      return
    }
    throw e
  }

  const lines = raw.trimEnd().split('\n').filter(Boolean)
  const slice = opts.tail ? lines.slice(-opts.tail) : lines
  for (const line of slice) {
    try {
      const entry = JSON.parse(line) as { ts: number; kind: string; data: unknown }
      const d = new Date(entry.ts).toISOString()
      const body = JSON.stringify(entry.data)
      console.log(`${d}  ${entry.kind.padEnd(16)} ${body.slice(0, 200)}`)
    } catch {
      console.log(line)
    }
  }
}
