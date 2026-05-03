import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolve `~/.anima` at call time so tests can override via ANIMA_ROOT or HOME. */
function animaRoot(): string {
  return process.env.ANIMA_ROOT ?? join(homedir(), '.anima')
}

export interface AgentPaths {
  readonly root: string
  readonly config: string
  readonly skills: string
  readonly plugins: string
  readonly agentsDir: string
  agent(id: string): {
    dir: string
    keystore: string
    cache: string
    memoryDir: string
    memoryIndex: string
    agentMemoryDir: string
    userMemoryDir: string
    publicDir: string
    activityLog: string
    runtimeState: string
    inboxDir: string
    pairingDir: string
  }
}

export const agentPaths: AgentPaths = {
  get root() {
    return animaRoot()
  },
  get config() {
    return join(animaRoot(), 'config.ts')
  },
  get skills() {
    return join(animaRoot(), 'skills')
  },
  get plugins() {
    return join(animaRoot(), 'plugins')
  },
  get agentsDir() {
    return join(animaRoot(), 'agents')
  },
  agent(id: string) {
    const dir = join(animaRoot(), 'agents', id)
    return {
      dir,
      keystore: join(dir, 'keystore.json'),
      cache: join(dir, 'cache'),
      memoryDir: join(dir, 'memory'),
      memoryIndex: join(dir, 'memory', 'MEMORY.md'),
      agentMemoryDir: join(dir, 'memory', 'agent'),
      userMemoryDir: join(dir, 'memory', 'user'),
      publicDir: join(dir, 'memory', 'public'),
      activityLog: join(dir, 'activity.jsonl'),
      runtimeState: join(dir, 'runtime', 'state.json'),
      inboxDir: join(dir, 'inbox'),
      pairingDir: join(dir, 'pairing'),
    }
  },
}

/** Compute the deterministic agent id from a wallet address. Stable pre-iNFT. */
export function placeholderAgentId(walletAddress: string): string {
  const clean = walletAddress.toLowerCase().replace(/^0x/, '')
  return clean.slice(0, 16)
}
